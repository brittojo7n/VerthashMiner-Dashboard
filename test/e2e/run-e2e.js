"use strict";
/*
 * End-to-end exercise: boots the REAL dashboard server with the mock VerthashMiner
 * process running and a mock nvidia-smi on PATH, then verifies the whole data path:
 *   miner stdout/stderr -> parser -> state -> SSE frames -> (client projection)
 * and cross-checks the console lines against the derived metric fields.
 *
 * Run: node test/e2e/run-e2e.js
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { Server } = require("../../server.js");
const { buildConfig } = require("../../src/config.js");

const ROOT = path.join(__dirname, "..", "..");
const MOCK_MINER = path.join(ROOT, "test", "mocks", "miner");
const MOCK_SMI_DIR = path.join(ROOT, "test", "mocks", "bin");

process.env.PATH = `${MOCK_SMI_DIR}:${process.env.PATH}`;
for (const k of Object.keys(process.env)) if (k.startsWith("MOCK_")) delete process.env[k];

let passed = 0, failed = 0;
const failures = [];
async function scenario(name, fn) {
  const start = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name} (${Date.now() - start}ms)`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`FAIL  ${name} (${Date.now() - start}ms)\n      ${err && err.message}`);
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, timeoutMs = 15000, everyMs = 100) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(everyMs);
  }
  return true;
}

async function boot({ minerEnv = {}, cfg = {}, passphrase = "" } = {}) {
  const config = buildConfig({
    PORT: "0",
    HOST: "127.0.0.1",
    SESSION_SECRET: "e2e-secret-" + "x".repeat(54),
    PASSPHRASE: passphrase,
    GPU_POLL_MS: "3000",
    MINER_EXE: MOCK_MINER,
    MINER_CWD: ROOT,
    MINER_ARGS: "-u VkcE2EWallet.rig1 --all-cu-devices",
    ...cfg
  });
  for (const [k, v] of Object.entries(minerEnv)) process.env[k] = String(v);
  const server = new Server({ config });
  server.start();
  await new Promise(r => server.httpServer.once("listening", r));
  const port = server.httpServer.address().port;
  return { server, port, config };
}
async function shutdown(booted) {
  // Server.stop() ends with process.exit() (it is the CLI shutdown path), so the
  // in-process harness tears the components down directly instead.
  const { server } = booted;
  try {
    await server.minerManager.stop();
    server.minerManager.dispose();
    server.gpuManager.stop();
    server.sseHub.closeAll();
    if (typeof server.httpServer.closeAllConnections === "function") server.httpServer.closeAllConnections();
    await new Promise(resolve => server.httpServer.close(() => resolve()));
  } catch { /* best effort */ }
}

/* ---- SSE client ---- */
function sse(port, { headers = {} } = {}) {
  const state = { frames: [], events: [], closed: false };
  const ctrl = new AbortController();
  const done = fetch(`http://127.0.0.1:${port}/events`, { signal: ctrl.signal, headers })
    .then(async res => {
      state.status = res.status;
      if (res.status !== 200) { state.closed = true; return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done: d } = await reader.read();
          if (d) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (block.startsWith(":")) continue;
            const evM = /^event: (.+)$/m.exec(block);
            const dataM = /^data: (.+)$/m.exec(block);
            if (!dataM) continue;
            const ev = evM ? evM[1] : "message";
            state.events.push(ev);
            if (ev === "stats") state.frames.push(JSON.parse(dataM[1]));
          }
        }
      } catch { /* aborted */ }
      state.closed = true;
    })
    .catch(() => { state.closed = true; });
  return {
    ...state,
    close() { ctrl.abort(); },
    waitDone: () => done,
    async first(ms = 8000) {
      await waitFor(() => state.frames.length > 0, ms, 25);
      return state.frames[0];
    },
    async until(cond, ms = 15000) {
      await waitFor(() => state.frames.some(cond), ms, 50);
      return [...state.frames].find(cond);
    }
  };
}

/* ---------- scenarios ---------- */

(async () => {
  console.log("\nE2E: healthy miner, live SSE, data-mapping cross-check\n");

  let boot1;
  await scenario("server boots, health endpoint, miner spawns, telemetry arrives", async () => {
    boot1 = await boot({ minerEnv: { MOCK_MODE: "healthy", MOCK_RATE_MS: "700", MOCK_SHARE_EVERY: "2500", MOCK_GPUS: "2" } });
    const { port } = boot1;
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(status.miner.running, true, "miner running");
    assert.equal(status.miner.wallet, "VkcE2EWallet", "wallet extracted from -u arg with worker suffix stripped");
    assert.ok(status.pid === null || typeof status.miner.pid === "number");
  });

  await scenario("SSE stream: full replay first, then incremental-only console frames", async () => {
    const { port } = boot1;
    const c1 = sse(port);
    const first = await c1.first();
    assert.ok(first.miner.logs.length > 0, "fresh client gets replayed context");
    assert.equal(first.logCapacity, 50);
    const seqAfterFirst = first.logSeq;
    const seenIds = new Set(first.miner.logs.map(l => l.id));
    const later = await c1.until(f => f.logSeq > seqAfterFirst + 3, 12000);
    assert.ok(later, "more lines arrived");
    for (const entry of later.miner.logs) {
      assert.ok(!seenIds.has(entry.id), "incremental frames never repeat lines");
      seenIds.add(entry.id);
    }
    assert.ok(later.miner.logs.length <= 50);
    c1.close();
  });

  await scenario("CROSS-CHECK: console lines vs derived metrics (hashrate sum, shares, difficulty, PCI join)", async () => {
    const { port } = boot1;
    const c = sse(port);
    await c.first();
    const target = await c.until(f => f.mining.status === "MINING" && f.gpu.length === 2 && f.mining.accepted >= 2, 20000);
    assert.ok(target, "reached MINING with telemetry and shares");

    // --- rebuild the metrics from the console lines the dashboard itself shows ---
    const lines = c.frames.flatMap(f => f.miner.logs.map(l => l.text));
    const dev = /cu_device\((\d+)\):\[.*?hashrate: ([\d.]+) kH\/s/;
    const lastRate = new Map();
    for (const l of lines) { const m = dev.exec(l); if (m) lastRate.set(`cu_${m[1]}`, Number(m[2])); }
    const sum = [...lastRate.values()].reduce((a, b) => a + b, 0);

    const share = /accepted: (\d+)\/(\d+)/;
    let accepted = 0, submitted = 0;
    for (const l of lines) { const m = share.exec(l); if (m) { accepted = Number(m[1]); submitted = Number(m[2]); } }

    // console must contain each documented line shape that is still inside the
    // 50-line ring buffer (startup banner lines are asserted on a fresh boot below)
    assert.ok(!lines.some(l => l.trim().startsWith("{")), "raw JSON protocol frames are consumed, not shown");

    const m = target.mining;
    assert.ok(Math.abs(m.hashrateKHs - sum) < 0.5, `rig hashrate ${m.hashrateKHs} == sum of per-device console rates ${sum.toFixed(2)}`);
    assert.equal(m.accepted, accepted, `accepted matches console: ${accepted}`);
    assert.equal(m.submitted, submitted, `submitted matches console: ${submitted}`);
    assert.equal(m.rejected, submitted - accepted, "rejected = submitted - accepted");
    assert.equal(m.difficulty, 0.0244140625, "difficulty from miner line");
    assert.ok(target.acceptedRatio == null || Math.abs(target.acceptedRatio - (accepted / submitted) * 100) < 0.01);

    // --- GPU telemetry join: nvidia-smi rows <-> CUDA hashrates via PCI bus id ---
    assert.equal(target.gpu.length, 2, "two GPUs from nvidia-smi");
    assert.equal(target.gpu[0].name, "NVIDIA GeForce RTX 3060");
    assert.equal(target.gpu[0].pciBusId, "01:00:0");
    const hr0 = lastRate.get("cu_0"), hr1 = lastRate.get("cu_1");
    assert.ok(hr0 && hr1, "per-device rates present in console");
    assert.equal(target.gpu[0].hashrate, hr0, "GPU0 telemetry card carries cu_device(0) hashrate via PCI join");
    assert.equal(target.gpu[1].hashrate, hr1, "GPU1 telemetry card carries cu_device(1) hashrate");
    for (const g of target.gpu) {
      assert.ok(g.temperatureC >= 55 && g.temperatureC <= 75, `temp plausible (${g.temperatureC}C)`);
      assert.ok(g.powerW >= 90 && g.powerW <= 145);
      assert.ok(g.utilizationPct >= 90);
      assert.ok(g.memoryTotalMB === 12288);
      assert.ok(["P1", "P2", "P3", "P4"].includes(g.pstate));
    }
    c.close();
  });

  await scenario("API surface: ETag/304, gzip, CSP, HEAD, 404", async () => {
    const { port } = boot1;
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.ok(page.headers.get("content-security-policy").includes("default-src 'self'"));
    const etag = page.headers.get("etag");
    const reval = await fetch(`${base}/`, { headers: { "if-none-match": etag } });
    assert.equal(reval.status, 304);
    const head = await fetch(`${base}/style.css`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, null);
    // undici decompresses transparently; use a raw socket to see the wire bytes
    const raw = (headers) => new Promise((resolve, reject) => {
      const req = require("node:http").get({ host: "127.0.0.1", port, path: "/js/app.js", headers }, res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, encoding: res.headers["content-encoding"] || "", bytes: Buffer.concat(chunks).length }));
      });
      req.on("error", reject);
    });
    const plain = await raw({});
    const gz = await raw({ "accept-encoding": "gzip" });
    assert.equal(gz.encoding, "gzip");
    assert.ok(gz.bytes < plain.bytes, `gzip is smaller (${gz.bytes} < ${plain.bytes})`);
    const nope = await fetch(`${base}/nope.js`);
    assert.equal(nope.status, 404);
    const nope2 = await fetch(`${base}/api/unknown`);
    assert.equal(nope2.status, 404);
  });

  await scenario("rate limits: /events and /api/status fixed windows with Retry-After", async () => {
    const { port } = boot1;
    const base = `http://127.0.0.1:${port}`;
    const live = sse(port); // occupies one /events slot
    await live.first();
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await fetch(`${base}/events`)).status);
    assert.deepEqual(codes.sort(), [200, 200, 429].sort(), "window allows 3, then 429");
    const limited = await fetch(`${base}/events`);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    const withRetry = await (await fetch(`${base}/api/status`)).json();
    assert.ok(withRetry.streamRetryAfterMs > 0, "status tells the client when the stream can resume");
    live.close();
    await sleep(3200); // window passes
    const after = await fetch(`${base}/api/status`);
    assert.equal(after.status, 200);
  });

  await scenario("miner control API: CSRF gate, restart + stop + start lifecycle", async () => {
    const { port } = boot1;
    const base = `http://127.0.0.1:${port}`;
    const csrf = await fetch(`${base}/api/miner/restart`, { method: "POST", headers: { "x-requested-with": "XMLHttpRequest" }, body: "" });
    assert.notEqual(csrf.status, 403, "same-origin XHR passes CSRF");
    const status1 = await (await fetch(`${base}/api/status`)).json();
    const minerStatus = async () => {
      try { const s = await (await fetch(`${base}/api/status`)).json(); return s && s.miner; } catch { return null; }
    };
    assert.ok(await waitFor(async () => {
      const m = await minerStatus();
      return m && m.running && m.pid !== status1.miner.pid;
    }, 15000), "restart produced a new pid");
    const noCsrf = await fetch(`${base}/api/miner/stop`, { method: "POST" });
    assert.equal(noCsrf.status, 403, "missing X-Requested-With rejected");
    const crossOrigin = await fetch(`${base}/api/miner/stop`, { method: "POST", headers: { "x-requested-with": "XMLHttpRequest", origin: "http://evil.example" } });
    assert.equal(crossOrigin.status, 403, "cross-origin rejected");
    const stop = await fetch(`${base}/api/miner/stop`, { method: "POST", headers: { "x-requested-with": "XMLHttpRequest" } });
    assert.equal(stop.status, 200);
    assert.ok(await waitFor(async () => {
      const m = await minerStatus();
      return m && m.running === false;
    }, 12000), "miner stopped");
    await sleep(2100); // control rate window (2 per 2s)
    const start = await fetch(`${base}/api/miner/start`, { method: "POST", headers: { "x-requested-with": "XMLHttpRequest" } });
    assert.equal(start.status, 200);
    assert.ok(await waitFor(async () => {
      const m = await minerStatus();
      return m && m.running === true;
    }, 12000), "miner restarted on demand");
  });

  await scenario("zero-idle: nvidia-smi spawns only while a client is attached", async () => {
    const { port } = boot1;
    const log = path.join(os.tmpdir(), `smi-e2e-${Date.now()}.log`);
    process.env.MOCK_SMI_LOG = log;
    const count = () => { try { return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
    await sleep(3300); // no viewers: nothing may fire, and any cooldown from earlier polls drains
    assert.equal(count(), 0, "no spawns with zero viewers");
    const c = sse(port);
    assert.ok(await c.first(), "viewer attached");
    assert.ok(await waitFor(() => count() > 0, 4000), "polling starts when a viewer attaches");
    c.close();
    const afterDetach = count();
    await sleep(6500);
    assert.equal(count(), afterDetach, "no spawns after last viewer leaves");
    delete process.env.MOCK_SMI_LOG;
    try { fs.unlinkSync(log); } catch {}
  });

  await scenario("multi-client: 3 viewers share one telemetry poll; 5th is rejected", async () => {
    const { port } = boot1;
    const log = path.join(os.tmpdir(), `smi-multi-${Date.now()}.log`);
    process.env.MOCK_SMI_LOG = log;
    const count = () => { try { return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
    const clients = [sse(port), sse(port), sse(port)];
    await Promise.all(clients.map(c => c.first()));
    const n0 = count();
    await sleep(3400);
    assert.ok(count() - n0 <= 2, `3 clients share the poll (${count() - n0} spawns in one interval)`);
    const extra = sse(port);
    assert.ok(await extra.first(), "4th viewer accepted");
    const fifth = sse(port);
    assert.ok(await waitFor(() => fifth.events.includes("rejected"), 4000), "5th concurrent viewer rejected");
    clients.push(extra);
    clients.forEach(c => c.close());
    fifth.close();
    delete process.env.MOCK_SMI_LOG;
    try { fs.unlinkSync(log); } catch {}
  });

  await shutdown(boot1);

  console.log("\nE2E: pool disconnect + recovery\n");
  let boot2;
  await scenario("fresh boot: startup console lines replayed verbatim", async () => {
    boot2 = await boot({ minerEnv: { MOCK_MODE: "pooldown", MOCK_RATE_MS: "700", MOCK_SHARE_EVERY: "3000" } });
    const c = sse(boot2.port);
    const withBanner = await c.until(f => f.miner.logs.some(l => l.text.includes("Configured 0(CL) and 2(CUDA) workers")), 10000);
    assert.ok(withBanner, "worker banner streamed");
    const lines = c.frames.flatMap(f => f.miner.logs.map(l => l.text));
    assert.ok(lines.some(l => l.includes("VerthashMiner-mock v1.0.1")), "banner replayed");
    assert.ok(lines.some(l => l.includes("2 miner threads started")), "thread banner replayed");
    assert.ok(lines.some(l => l.includes("Stratum difficulty set to 0.0244140625")), "difficulty line replayed");
    assert.ok(lines.some(l => l.includes("Stratum connection succeeded")), "connection line replayed");
    assert.ok(lines.some(l => /cu_device\(0\):\[ temp:\d+C/.test(l)), "per-device stat line replayed");
    c.close();
  });
  await scenario("stratum outage flips DISCONNECTED, recovery restores MINING and clears the error", async () => {
    boot2 = await boot({ minerEnv: { MOCK_MODE: "pooldown", MOCK_RATE_MS: "700", MOCK_SHARE_EVERY: "3000" } });
    const c = sse(boot2.port);
    await c.first();
    const down = await c.until(f => f.mining.status === "DISCONNECTED", 12000);
    assert.ok(down, "pool outage detected");
    assert.ok(/timed out|recv_line/.test(down.miner.lastError), "lastError carries the stratum failure");
    assert.ok(down.miner.lastError.length > 0);
    const downIdx = c.frames.indexOf(down);
    // look for recovery strictly after the outage frame (earlier frames are pre-outage MINING)
    const back = await c.until(f => c.frames.indexOf(f) > downIdx && f.mining.status === "MINING" && !f.miner.lastError, 20000);
    assert.ok(back, "reconnected and error cleared");
    assert.equal(back.mining.difficulty, 0.048828125, "new difficulty after reconnect");
    c.close();
  });
  await shutdown(boot2);

  console.log("\nE2E: crash + GPU failure paths\n");
  let boot3;
  await scenario("miner crash surfaces CRASHED + exit code", async () => {
    boot3 = await boot({ minerEnv: { MOCK_MODE: "crash" } });
    const c = sse(boot3.port);
    await c.first();
    const crashed = await c.until(f => f.mining.status === "CRASHED", 12000);
    assert.ok(crashed, "crash detected");
    assert.equal(crashed.miner.exitCode, 1);
    assert.match(crashed.miner.lastError, /out of memory/i);
    assert.equal(crashed.miner.running, false);
    c.close();
  });
  await scenario("nvidia-smi failure surfaces gpuError and backs off", async () => {
    process.env.MOCK_SMI_MODE = "fail";
    const log = path.join(os.tmpdir(), `smi-fail-${Date.now()}.log`);
    process.env.MOCK_SMI_LOG = log;
    const c = sse(boot3.port);
    const f = await c.until(x => x.gpuError && x.gpuError.includes("failed"), 14000);
    assert.ok(f, "gpuError surfaced in snapshot");
    const count = () => { try { return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
    const n = count();
    await sleep(7000);
    const grown = count() - n;
    assert.ok(grown <= 2, `failure backoff throttles spawns (${grown} in 7s)`);
    c.close();
    delete process.env.MOCK_SMI_LOG;
    delete process.env.MOCK_SMI_MODE;
    try { fs.unlinkSync(log); } catch {}
  });
  await shutdown(boot3);

  console.log("\nE2E: authenticated mode\n");
  let boot4;
  await scenario("auth wall: 401s, CSRF on login, bad passphrases, lockout, cookie session", async () => {
    boot4 = await boot({ passphrase: "correct horse battery", minerEnv: { MOCK_MODE: "silent" } });
    const base = `http://127.0.0.1:${boot4.port}`;
    assert.equal((await fetch(`${base}/api/status`)).status, 401, "status gated");
    assert.equal((await fetch(`${base}/events`)).status, 401, "stream gated");
    const noHeader = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: "correct horse battery" }) });
    assert.equal(noHeader.status, 403, "login without X-Requested-With is CSRF-blocked");
    const cross = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", origin: "http://evil.example" }, body: JSON.stringify({ passphrase: "correct horse battery" }) });
    assert.equal(cross.status, 403, "cross-origin login blocked");
    let cookie = null;
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" }, body: JSON.stringify({ passphrase: "wrong" }) });
      assert.equal(res.status, 401);
    }
    const locked = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" }, body: JSON.stringify({ passphrase: "correct horse battery" }) });
    assert.equal(locked.status, 429, "lockout after repeated failures");
    await sleep(31000); // lockout window (30s) — padded
    const ok = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" }, body: JSON.stringify({ passphrase: "correct horse battery" }) });
    assert.equal(ok.status, 200, "login succeeds after lockout expires");
    cookie = ok.headers.get("set-cookie").split(";")[0];
    assert.match(cookie, /vm_session=[0-9a-f]{16,}/);
    const authed = await fetch(`${base}/api/status`, { headers: { cookie } });
    assert.equal(authed.status, 200);
    const stream = sse(boot4.port, { headers: { cookie } });
    assert.ok(await stream.first(), "SSE authorized with session cookie");
    stream.close();
    const badBody = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" }, body: "not json" });
    assert.equal(badBody.status, 400);
    const tooBig = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" }, body: "x".repeat(9000) });
    assert.equal(tooBig.status, 413);
  });
  await shutdown(boot4);

  console.log(`\nE2E result: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`- ${f.name}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
  setTimeout(() => process.exit(process.exitCode || 0), 300).unref();
})().catch(err => { console.error(err); process.exit(1); });
