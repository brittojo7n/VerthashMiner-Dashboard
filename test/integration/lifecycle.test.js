"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { startServer, request, sseClient, delay } = require("../helpers/harness");
const { LIMITS } = require("../../src/constants");

const XHR = { "X-Requested-With": "XMLHttpRequest" };

test("start -> mining -> stop leaves no child behind", async t => {
  const app = await startServer();
  t.after(() => app.close());

  await app.minerManager.start();
  assert.equal(app.state.miner.running, true);
  const pid = app.state.miner.pid;
  assert.ok(pid > 0);

  await app.minerManager.stop();
  assert.equal(app.state.miner.running, false);
  assert.equal(app.state.mining.status, "STOPPED");
  assert.equal(app.minerManager.proc, null);

  await delay(100);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "child process is gone");
});

test("restart tears the old process down before starting a new one", async t => {
  const app = await startServer();
  t.after(() => app.close());

  await app.minerManager.start();
  const firstPid = app.state.miner.pid;

  await app.minerManager.restart();
  const secondPid = app.state.miner.pid;

  assert.notEqual(secondPid, firstPid);
  assert.equal(app.state.miner.running, true);
  await delay(100);
  assert.throws(() => process.kill(firstPid, 0), /ESRCH/);
});

test("counters reset on restart instead of inheriting the previous run", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const client = sseClient(app.origin);
  await client.ready;
  await client.waitFor(() => true);

  await app.minerManager.start();
  await client.waitFor(s => s.mining.accepted >= 1, 15000);

  await app.minerManager.stop();
  assert.equal(app.state.mining.accepted, 0);
  assert.equal(app.state.mining.submitted, 0);
  assert.equal(app.state.mining.rejected, 0);
  assert.equal(app.state.mining.hashrateKHs, null);
  assert.deepEqual({ ...app.state.mining.gpuHashrates }, {});
  assert.deepEqual(app.state.mining.seenDevices, [], "stale device set must be cleared");
  assert.equal(app.state.mining.expectedWorkers, 0);

  client.close();
});

test("the total hashrate is correct again after a restart", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const client = sseClient(app.origin);
  await client.ready;
  await client.waitFor(() => true);

  await app.minerManager.start();
  await client.waitFor(s => s.mining.hashrateKHs > 0, 15000);
  await app.minerManager.restart();

  const after = await client.waitFor(s => s.mining.hashrateKHs > 0 && s.miner.running, 15000);
  // Two devices, both reported: never a single-GPU total presented as the rig.
  assert.ok(after.mining.hashrateKHs > 300, `partial total leaked: ${after.mining.hashrateKHs}`);

  client.close();
});

test("double clicking a control cannot spawn two miners", async t => {
  const app = await startServer();
  t.after(() => app.close());

  for (let i = 0; i < 5; i++) app.minerManager.requestAction("start");
  await delay(LIMITS.ACTION_DELAY_MS + 400);

  assert.equal(app.state.miner.running, true);
  const pid = app.state.miner.pid;

  for (let i = 0; i < 5; i++) app.minerManager.requestAction("start");
  await delay(LIMITS.ACTION_DELAY_MS + 400);
  assert.equal(app.state.miner.pid, pid, "no second spawn");
});

test("stop while starting is honoured and does not leak a process", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const starting = app.minerManager.start();
  await app.minerManager.stop();
  await starting;
  await delay(300);

  assert.equal(app.state.mining.status, "STOPPED");
  assert.equal(app.state.miner.running, false);
});

test("a crashing miner is reported as CRASHED, not silently stopped", async t => {
  const app = await startServer({ mock: { mode: "crash", intervalMs: 1 } });
  t.after(() => app.close());

  const client = sseClient(app.origin);
  await client.ready;
  await client.waitFor(() => true);

  await app.minerManager.start();
  const crashed = await client.waitFor(s => s.mining.status === "CRASHED", 15000);

  assert.equal(crashed.miner.running, false);
  assert.equal(crashed.miner.exitCode, 1);
  assert.ok(
    client.snapshots.some(s => s.miner.logs.some(l => /Exited \(code: 1/.test(l.text))),
    "the exit is written to the console"
  );

  client.close();
});

test("a missing miner binary is reported instead of crashing the dashboard", async t => {
  const app = await startServer({
    env: { MINER_EXE: "/nonexistent/VerthashMiner", MINER_ARGS: "-u wallet --all-cu-devices" }
  });
  t.after(() => app.close());

  await app.minerManager.start();
  await delay(400);

  assert.equal(app.state.miner.running, false);
  assert.match(app.state.miner.lastError, /ENOENT|not found|spawn/i);
  assert.equal((await request(app.origin, "/health")).status, 200, "dashboard still serving");
});

test("an unconfigured miner path fails loudly but keeps the UI alive", async t => {
  const app = await startServer({ env: { MINER_CWD: "" } });
  t.after(() => app.close());

  await app.minerManager.start();
  assert.equal(app.state.mining.status, "STOPPED");
  assert.match(app.state.miner.lastError, /MINER_CWD/);
  assert.equal((await request(app.origin, "/health")).status, 200);
});

test("a hung miner that ignores SIGINT is force killed within the watchdog", async t => {
  const app = await startServer({ mock: { mode: "hang" } });
  t.after(() => app.close());

  await app.minerManager.start();
  await delay(200);
  const pid = app.state.miner.pid;
  assert.ok(pid > 0);

  const started = Date.now();
  await app.minerManager.stop();
  const elapsed = Date.now() - started;

  assert.ok(elapsed < LIMITS.STOP_TIMEOUT_MS, `stop took ${elapsed}ms`);
  assert.equal(app.state.mining.status, "STOPPED");
  await delay(150);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "force kill worked");
});

test("a hung --device-list probe cannot block the miner from starting", async t => {
  const app = await startServer({ mock: { mode: "probehang" }, timeouts: { probe: 800 } });
  t.after(() => app.close());

  const started = Date.now();
  await app.minerManager.start();
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 700, "the probe watchdog is what released the start");
  assert.ok(elapsed < 5000, `start blocked for ${elapsed}ms`);
  assert.equal(app.state.miner.running, true, "miner started despite the dead probe");
  assert.ok(
    app.state.miner.logs.toJSON().some(l => /Device probe timed out/.test(l.text)),
    "the operator is told why PCI mapping is missing"
  );
});

test("a failing probe degrades to positional GPU mapping", async t => {
  const app = await startServer({ mock: { mode: "probefail" } });
  t.after(() => app.close());

  await app.minerManager.start();
  await delay(400);

  assert.equal(app.state.miner.running, true);
  assert.deepEqual({ ...app.state.mining.pciMap }, {}, "no bogus mapping invented");
});

test("HTTP controls drive the same lifecycle as the API", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const start = await request(app.origin, "/api/miner/start", { method: "POST", headers: XHR });
  assert.equal(start.status, 200);
  assert.equal(app.state.mining.status, "STARTING");

  await delay(LIMITS.ACTION_DELAY_MS + 500);
  assert.equal(app.state.miner.running, true);

  const stop = await request(app.origin, "/api/miner/stop", { method: "POST", headers: XHR });
  assert.equal(stop.status, 200);
  await delay(LIMITS.ACTION_DELAY_MS + 800);
  assert.equal(app.state.miner.running, false);
});

test("control endpoints are rate limited against click storms", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const codes = [];
  for (let i = 0; i < 6; i++) {
    const res = await request(app.origin, "/api/miner/restart", { method: "POST", headers: XHR });
    codes.push(res.status);
  }
  assert.ok(codes.includes(429), `expected throttling, got ${codes.join(",")}`);
});
