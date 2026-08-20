"use strict";
/*
 * Tablet emulation & FPS harness.
 *
 * Emulates a low-end 4 GB / quad-core tablet (the reported device) with:
 *   - navigator.deviceMemory = 4, hardwareConcurrency = 4
 *   - CPU throttling 6x (CDP Emulation.setCPUThrottlingRate)
 *   - software GPU compositing (SwiftShader) - comparable to a weak tablet GPU
 * then measures real frame rates while the live dashboard streams data:
 *   phase 1: idle (SSE updates, clock ticks)
 *   phase 2: main-page scroll over the top grid (glass panels)
 *   phase 3: console inner scroll
 *
 * Scenarios:
 *   old-tablet : pre-change client  (expect: fx wrongly enabled -> jank)
 *   new-tablet : current client     (expect: lite tier, ~60 fps everywhere)
 *   new-desktop: current client, unthrottled desktop profile (expect: fx on)
 *
 * Run: node test/browser/fps.js
 */
const assert = require("node:assert/strict");
const puppeteer = require("puppeteer-core");
const { launchBrowser, bootServer, stopServer, oldPublicDir, sleep } = require("./lib.js");

const TABLET_VIEWPORT = { width: 800, height: 1280 };
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const THROTTLE = Number(process.env.THROTTLE || 6);

const results = [];
let failures = 0;

async function openPage(browser, { port, memory, cores, throttle, viewport, freezeClock }) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({
    ...viewport, deviceScaleFactor: 1,
    isMobile: viewport === TABLET_VIEWPORT, hasTouch: viewport === TABLET_VIEWPORT
  });
  await page.evaluateOnNewDocument(
    ({ memory, cores, freezeClock }) => {
      Object.defineProperty(navigator, "deviceMemory", { get: () => memory, configurable: true });
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => cores, configurable: true });
      if (freezeClock) {
        const FIXED = 1755710000000;
        Date.now = () => FIXED;
      }
      window.__rafTimes = [];
      const loop = t => { window.__rafTimes.push(t); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      setTimeout(() => { window.__vmSettled = true; }, 6000);
    },
    { memory, cores, freezeClock: freezeClock || false }
  );
  const cdp = await page.createCDPSession();
  if (throttle) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const hr = document.getElementById("hashrate");
    const cards = document.querySelectorAll(".gpu-panel").length;
    return hr && hr.textContent !== "\u2014" && cards >= 1;
  }, { timeout: 25000 });
  return { page, context, cdp };
}

async function measurePhase(page, label, drive, ms = 3000) {
  const t0 = await page.evaluate(() => performance.now());
  const driveDone = drive ? drive() : Promise.resolve();
  const driveStart = Date.now();
  while (Date.now() - driveStart < ms) {
    await sleep(Math.min(200, ms - (Date.now() - driveStart)));
    if (driveDone && (await Promise.race([driveDone.then(() => 1), sleep(0).then(() => 0)]))) break;
  }
  await sleep(150); // let the last frames land
  const t1 = await page.evaluate(() => performance.now());
  const stats = await page.evaluate((a, b) => {
    const ts = window.__rafTimes.filter(t => t >= a && t <= b);
    const gaps = [];
    for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
    const sorted = gaps.slice().sort((x, y) => x - y);
    const fps = ts.length > 1 ? ((ts.length - 1) / ((b - a) / 1000)) : 0;
    const overBudget = gaps.length ? gaps.filter(g => g > 20).length / gaps.length : 0;
    // per-second buckets: robust to a single background burst inside the window
    const buckets = [];
    for (let s = a; s < b; s += 1000) {
      const inBucket = ts.filter(t => t >= s && t < s + 1000);
      if (inBucket.length > 1) buckets.push((inBucket.length - 1)); // frames produced in that second
    }
    buckets.sort((x, y) => x - y);
    const medianBucket = buckets.length ? buckets[buckets.length >> 1] : 0;
    const bestBucket = buckets.length ? buckets[buckets.length - 1] : 0;
    return {
      frames: ts.length,
      fps,
      fps1s: medianBucket,
      best1s: bestBucket,
      overBudget,
      medianGap: sorted.length ? sorted[sorted.length >> 1] : null,
      p95Gap: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : null,
      worstGap: sorted.length ? sorted[sorted.length - 1] : null
    };
  }, t0, t1);
  return { label, ...stats };
}

async function scrollGestures(cdp, opts, times, ms) {
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < ms) {
    i++;
    try {
      await cdp.send("Input.synthesizeScrollGesture", {
        x: opts.x, y: opts.y,
        yDistance: i % 2 === 1 ? opts.dist : -opts.dist,
        speed: opts.speed,
        gestureSourceType: "touch"
      });
    } catch { /* gesture sink unavailable */ }
    await sleep(opts.hold || 60);
  }
}

async function runScenario(browser, name, { publicDir, memory, cores, throttle, viewport, minerEnv, smiMode }) {
  const booted = await bootServer({ minerEnv, smiMode, publicDir });
  const run = { name, phases: [] };
  try {
    const { page, context, cdp } = await openPage(browser, {
      port: booted.port, memory, cores, throttle, viewport
    });
    // wait for the gate to settle: probe done, and any governor demote landed
    await page.waitForFunction(() => {
      const g = window.__vmPerf && window.__vmPerf.gate;
      if (!g) return true; // old client has no gate
      if (g.mode === "lite") return true;
      return document.documentElement.classList.contains("fx") && window.__vmSettled === true;
    }, { timeout: 12000 }).catch(() => { });
    await sleep(3200); // live stream + telemetry + toasts settle

    run.hasFx = await page.evaluate(() => document.documentElement.classList.contains("fx"));
    run.gate = await page.evaluate(() => {
      const g = window.__vmPerf && window.__vmPerf.gate;
      return g ? { mode: g.mode, locked: g.locked, reason: g.reason } : { mode: "n/a (old client)" };
    });

    // phase 1: idle with live stream
    run.phases.push(await measurePhase(page, "idle", null, 2500));

    // phase 2: main-page scroll through the top grid
    const pageHeight = await page.evaluate(() => document.body.scrollHeight);
    run.phases.push(await measurePhase(page, "page-scroll(top grid)", () =>
      scrollGestures(cdp, { x: Math.round(viewport.width / 2), y: Math.round(viewport.height * 0.35), dist: -Math.min(500, pageHeight / 3), speed: 700 }, 0, 3000), 3200));

    // phase 3: console inner scroll
    const term = await page.evaluate(() => {
      const el = document.getElementById("terminal");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 300)) };
    });
    if (term) {
      run.phases.push(await measurePhase(page, "console-scroll", () =>
        scrollGestures(cdp, { x: term.x, y: term.y, dist: -400, speed: 700 }, 0, 3000), 3200));
    }

    await context.close();
  } finally {
    await stopServer(booted);
  }
  results.push(run);
  return run;
}

async function governorSelfHeal(browser) {
  /*
   * Deterministic mechanism test: force the fx tier on the throttled tablet
   * profile, then degrade real frame times with an in-page main-thread load.
   * The governor must demote to lite and lock the session within seconds.
   */
  const booted = await bootServer({
    minerEnv: { MOCK_MODE: "flood", MOCK_RATE_MS: "400", MOCK_SHARE_EVERY: "2000", MOCK_GPUS: "2" },
    smiMode: "ok"
  });
  const out = {};
  try {
    const { page, context } = await openPage(browser, {
      port: booted.port, memory: 4, cores: 4, throttle: THROTTLE, viewport: TABLET_VIEWPORT
    });
    await sleep(1500);
    out.forced = await page.evaluate(() => {
      document.documentElement.classList.add("fx");
      window.__vmPerf && window.__vmPerf.startGovernor();
      // ~10ms of real main-thread layout work per frame; under 6x throttle
      // this reliably exceeds the 60fps budget -> governor must react
      const sink = document.getElementById("gpus") || document.body;
      window.__heavyLoop = true;
      const burn = () => {
        if (!window.__heavyLoop) return;
        const t0 = performance.now();
        while (performance.now() - t0 < 10) void sink.offsetWidth;
        requestAnimationFrame(burn);
      };
      requestAnimationFrame(burn);
      return document.documentElement.classList.contains("fx");
    });
    await sleep(6500); // two+ governor windows
    out.after = await page.evaluate(() => ({
      fx: document.documentElement.classList.contains("fx"),
      mode: window.__vmPerf ? window.__vmPerf.gate.mode : null,
      locked: window.__vmPerf ? window.__vmPerf.gate.locked : null,
      reason: window.__vmPerf ? window.__vmPerf.gate.reason : null,
      sessionLock: window.sessionStorage.getItem("vmd:fxLock")
    }));
    await context.close();
  } finally {
    await stopServer(booted);
  }
  return out;
}

(async () => {
  console.log(`\nFPS harness — emulated tablet: deviceMemory=4, cores=4, CPU throttle ${THROTTLE}x, software compositing\n`);
  const browser = await launchBrowser(puppeteer);
  const oldDir = oldPublicDir();
  const flood = { MOCK_MODE: "flood", MOCK_RATE_MS: "400", MOCK_SHARE_EVERY: "2000", MOCK_GPUS: "2" };

  try {
    const oldTablet = await runScenario(browser, "BEFORE: old client, tablet profile", {
      publicDir: oldDir, memory: 4, cores: 4, throttle: THROTTLE, viewport: TABLET_VIEWPORT,
      minerEnv: flood, smiMode: "ok"
    });
    const newTablet = await runScenario(browser, "AFTER: new client, tablet profile", {
      publicDir: undefined, memory: 4, cores: 4, throttle: THROTTLE, viewport: TABLET_VIEWPORT,
      minerEnv: flood, smiMode: "ok"
    });
    const newDesktop = await runScenario(browser, "AFTER: new client, desktop profile (no throttle)", {
      publicDir: undefined, memory: 8, cores: 8, throttle: 0, viewport: DESKTOP_VIEWPORT,
      minerEnv: flood, smiMode: "ok"
    });
    const heal = await governorSelfHeal(browser);

    console.log("\n=== RESULTS ===");
    for (const r of results) {
      console.log(`\n[${r.name}]`);
      console.log(`  fx tier      : ${r.hasFx ? "FX (real-time blur)" : "LITE (no blur)"}  gate=${JSON.stringify(r.gate)}`);
      for (const p of r.phases) {
        console.log(`  ${p.label.padEnd(24)} ${p.fps.toFixed(1).padStart(6)} fps (median 1s: ${String(p.fps1s).padStart(2)}, best 1s: ${String(p.best1s).padStart(2)})   median gap ${String(p.medianGap == null ? "-" : p.medianGap.toFixed(1)).padStart(6)}ms   p95 ${String(p.p95Gap == null ? "-" : p.p95Gap.toFixed(1)).padStart(6)}ms   worst ${String(p.worstGap == null ? "-" : p.worstGap.toFixed(0)).padStart(5)}ms   >20ms ${(p.overBudget * 100).toFixed(0).padStart(3)}%   frames ${p.frames}`);
      }
    }

    // Assertions
    console.log("\n=== VERDICTS ===");
    const check = (cond, msg) => {
      console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
      if (!cond) failures++;
    };
    const soft = (cond, msg) => console.log(`${cond ? "good" : "note"}  ${msg}`);
    check(oldTablet.hasFx === true, "BEFORE: 4GB tablet was wrongly upgraded to the fx blur tier (bug reproduced)");
    // the guarantee is not "tablet is always lite" but "fx only while the device
    // actually holds 60hz" - either outcome must show clean pacing
    if (newTablet.hasFx) {
      for (const p of newTablet.phases.filter(x => x.label !== "idle")) {
        check(p.medianGap <= 17.5 && p.fps1s >= 45,
          `AFTER tablet ${p.label}: fx tier EARNED - ${p.fps1s} fps median 1s, gap ${p.medianGap.toFixed(1)}ms (60hz held)`);
      }
    } else {
      check(true, `AFTER tablet: probe rejected fx on this unit (gate=${JSON.stringify(newTablet.gate.reason)})`);
    }
    for (const p of newTablet.phases) {
      if (p.label === "idle") {
        check(p.p95Gap === null || p.p95Gap <= 34 || p.frames < 60,
          `AFTER tablet idle: no janky loops (p95 ${p.p95Gap == null ? "-" : p.p95Gap.toFixed(1)}ms, ${p.frames} frames)`);
      } else {
        check(p.fps1s >= 45, `AFTER tablet ${p.label}: median 1s rate ${p.fps1s} fps >= 45 under ${THROTTLE}x throttle (best second ${p.best1s})`);
        check(p.medianGap !== null && p.medianGap <= 17.5, `AFTER tablet ${p.label}: median frame gap ${p.medianGap == null ? "-" : p.medianGap.toFixed(1)}ms = 60Hz cadence`);
      }
    }
    // softer, environment-dependent comparisons (report-only)
    const oldIdle = oldTablet.phases[0];
    const newIdle = newTablet.phases[0];
    if (oldIdle.p95Gap != null && newIdle.p95Gap != null) {
      soft(newIdle.p95Gap < oldIdle.p95Gap,
        `idle tail: AFTER p95 ${newIdle.p95Gap.toFixed(1)}ms vs BEFORE ${oldIdle.p95Gap.toFixed(1)}ms (fx loops were the jank source)`);
    }
    const scrollAvg = r => {
      const s = r.phases.filter(p => p.label !== "idle");
      return s.reduce((a, p) => a + p.fps1s, 0) / s.length;
    };
    soft(scrollAvg(newTablet) >= scrollAvg(oldTablet) - 1,
      `scroll throughput: AFTER ${scrollAvg(newTablet).toFixed(1)} vs BEFORE ${scrollAvg(oldTablet).toFixed(1)} fps median 1s`);
    // deterministic self-heal: the mechanism that protects the real weak tablet
    console.log(`\ngovernor self-heal: forced fx=${heal.forced}, then degraded frame times -> ${JSON.stringify(heal.after)}`);
    check(heal.after.fx === false && heal.after.mode === "lite" && heal.after.locked === true,
      "governor demoted forced fx to lite when 60fps could not be held");
    check(heal.after.sessionLock === "1", "demotion is remembered for the tab session (no re-jank on reload)");
    check(newDesktop.hasFx === true, "AFTER: desktop profile still gets the full fx tier (visuals preserved)");
    for (const p of newDesktop.phases) {
      if (p.label !== "idle") {
        check(p.fps1s >= 55, `AFTER desktop ${p.label}: ${p.fps1s} fps`);
        check(p.overBudget <= 0.01, `AFTER desktop ${p.label}: ${(p.overBudget * 100).toFixed(1)}% frames over budget (locked 60)`);
      }
    }

    console.log(failures === 0 ? "\nALL FPS CHECKS PASSED" : `\n${failures} FPS CHECKS FAILED`);
  } finally {
    await browser.close();
  }
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
