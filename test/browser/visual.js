"use strict";
/*
 * Visual parity proof: the performance changes must not alter what the app
 * looks like on a capable machine (full fx tier).
 *
 * Method: boot the OLD client (HEAD commit) and the NEW client against
 * deterministic, clock-frozen data (static miner output + static nvidia-smi +
 * frozen server and page clocks), render both at the desktop profile, and
 * pixel-diff the full-page screenshots. Expected: zero differing pixels
 * (minor anti-aliasing noise tolerated below 0.02%).
 *
 * Run: node test/browser/visual.js
 */
const path = require("node:path");
const { launchBrowser, bootServer, stopServer, oldPublicDir, sleep } = require("./lib.js");
const { PNG } = require("pngjs");
const pixelmatch = require("pixelmatch");
const puppeteer = require("puppeteer-core");

const OUT = path.join(__dirname, "out");

async function shoot(browser, publicDir, tag) {
  const booted = await bootServer({
    minerEnv: { MOCK_MODE: "visual", MOCK_FROZEN_TIME: "1", MOCK_GPUS: "2" },
    smiMode: "static",
    publicDir,
    freezeTime: true
  });
  try {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8, configurable: true });
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8, configurable: true });
      const FIXED = 1755710000000;
      Date.now = () => FIXED;
    });
    await page.goto(`http://127.0.0.1:${booted.port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const hr = document.getElementById("hashrate");
      const cards = document.querySelectorAll(".gpu-panel");
      const logs = document.querySelectorAll(".log-entry");
      const bars = [...document.querySelectorAll(".bar-fill")];
      const barReady = bars.length >= 2 && bars.every(b => {
        const m = /scaleX\(([\d.]+)\)/.exec(b.style.transform);
        const w = /([\d.]+)%/.exec(b.style.width);
        return (m && Number(m[1]) > 0.99) || (w && Number(w[1]) >= 99.5);
      });
      return hr && hr.textContent !== "\u2014" && cards.length >= 2 && logs.length >= 5 && barReady
        && document.documentElement.classList.contains("fx");
    }, { timeout: 25000 });
    await page.evaluate(async () => { try { await document.fonts.ready; } catch { } });
    await sleep(4600); // toasts (3s lifetime) fully gone, telemetry settled
    const file = path.join(OUT, `${tag}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const fx = await page.evaluate(() => ({
      fx: document.documentElement.classList.contains("fx"),
      backdrops: [...document.querySelectorAll(".glass-panel, .glass-pill, .refresh-btn")]
        .filter(el => getComputedStyle(el).backdropFilter && getComputedStyle(el).backdropFilter !== "none").length,
      barTransform: (document.querySelector(".bar-fill") || {}).style ? document.querySelector(".bar-fill").style.transform || "(width mode)" : "?"
    }));
    await context.close();
    return { file, fx };
  } finally {
    await stopServer(booted);
  }
}

(async () => {
  require("node:fs").mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser(puppeteer);
  try {
    const oldShot = await shoot(browser, oldPublicDir(), "old");
    const newShot = await shoot(browser, undefined, "new");
    console.log("old fx:", JSON.stringify(oldShot.fx));
    console.log("new fx:", JSON.stringify(newShot.fx));

    const readPng = async file => {
      for (let i = 0; i < 5; i++) {
        try { return PNG.sync.read(require("node:fs").readFileSync(file)); }
        catch { await sleep(150); }
      }
      throw new Error(`could not decode ${file}`);
    };
    const a = await readPng(oldShot.file);
    const b = await readPng(newShot.file);
    if (a.width !== b.width || a.height !== b.height) {
      console.error(`FAIL dimensions differ: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
      process.exit(1);
    }
    const diff = new PNG({ width: a.width, height: a.height });
    const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
    const total = a.width * a.height;
    const pct = (changed / total) * 100;
    require("node:fs").writeFileSync(path.join(OUT, "diff.png"), PNG.sync.write(diff));
    console.log(`pixel diff: ${changed} / ${total} (${pct.toFixed(4)}%)`);

    const okFx = oldShot.fx.fx === true && newShot.fx.fx === true && newShot.fx.backdrops >= 8;
    const okPixels = changed <= Math.ceil(total * 0.0002);
    console.log(okFx ? "PASS  both clients render the full fx glass tier (real backdrop-filter)" : "FAIL  fx tier mismatch");
    console.log(okPixels ? "PASS  visuals are pixel-identical (<= 0.02% differing pixels)" : `FAIL  visual drift too high (${pct.toFixed(4)}%)`);
    process.exit(okFx && okPixels ? 0 : 1);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
