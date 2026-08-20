"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { MinerManager, resolveExe } = require("../../src/miner");
const { buildConfig } = require("../../src/config");
const { createState } = require("../../src/state");
const { STATUS, LIMITS } = require("../../src/constants");

const MOCK = path.join(__dirname, "..", "mocks", "miner");
const ROOT = path.join(__dirname, "..", "..");

function makeManager(envOverrides = {}, timeouts = {}) {
  // env knobs are process-global: scrub leftovers so tests stay independent
  for (const key of Object.keys(process.env)) if (key.startsWith("MOCK_")) delete process.env[key];
  const config = buildConfig({
    PORT: "0", HOST: "127.0.0.1", SESSION_SECRET: "t".repeat(64),
    MINER_EXE: MOCK, MINER_CWD: ROOT,
    MINER_ARGS: "-u VkcTest.worker --all-cu-devices",
    ...envOverrides
  });
  // the mock miner reads MOCK_* knobs from its environment
  for (const [key, value] of Object.entries(envOverrides)) {
    if (key.startsWith("MOCK_")) process.env[key] = String(value);
  }
  const state = createState("VkcTest", LIMITS.MAX_LOGS);
  const manager = new MinerManager({ config, state, onUpdate: () => {}, timeouts });
  return { manager, state, config };
}
const settle = (ms = 500) => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, timeoutMs = 8000, everyMs = 50) {
  const start = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise(r => setTimeout(r, everyMs));
  }
}
const statuses = s => [s.mining.status, s.miner.running];

test("resolveExe: pathless exe resolved against cwd when present, else PATH", () => {
  assert.equal(resolveExe(MOCK, ROOT), MOCK);
  assert.equal(resolveExe("definitely-not-on-disk.exe", ROOT), "definitely-not-on-disk.exe");
});

test("lifecycle: start -> probe -> running -> stop", async () => {
  const { manager: m, state } = makeManager({ MOCK_MODE: "quiet" });
  await m.start();
  assert.ok(await waitFor(() => state.miner.running && state.miner.pid > 0), "miner running after probe");
  assert.equal(state.mining.status, STATUS.STARTING);
  assert.deepEqual({ ...state.mining.pciMap }, { "01:00:0": "0", "06:00:0": "1" }, "probe fills the PCI map");
  await m.stop();
  await settle(300);
  assert.equal(state.mining.status, STATUS.STOPPED);
  assert.equal(state.miner.running, false);
  assert.equal(m.proc, null);
});

test("lifecycle: unclean exit code maps to CRASHED, clean exit to STOPPED", async () => {
  const crash = makeManager({ MOCK_MODE: "crash" });
  await crash.manager.start();
  await settle(5600);
  assert.equal(crash.state.mining.status, STATUS.CRASHED);
  assert.equal(crash.state.miner.exitCode, 1);
  assert.equal(crash.state.miner.running, false);

  const clean = makeManager({ MOCK_DURATION_MS: "600", MOCK_EXIT_CODE: "0" });
  await clean.manager.start();
  await settle(1400);
  assert.equal(clean.state.mining.status, STATUS.STOPPED, "exit 0 without deliberate stop is STOPPED");
});

test("lifecycle: missing config -> STOPPED with a warning, no child", async () => {
  const { manager: m, state } = makeManager({ MINER_CWD: "" });
  await m.start();
  assert.equal(state.mining.status, STATUS.STOPPED);
  assert.ok(state.miner.lastError.includes("MINER_CWD"));
  assert.equal(m.proc, null);
});

test("requestAction: start when already alive is a no-op; stop when idle is instant", async () => {
  const { manager: m, state } = makeManager({ MOCK_MODE: "quiet" });
  m.requestAction("start");
  assert.ok(await waitFor(() => state.miner.running));
  const pidBefore = state.miner.pid;
  m.requestAction("start"); // must not spawn a second child
  await settle(200);
  assert.equal(state.miner.pid, pidBefore);
  await m.stop();
  m.requestAction("stop"); // idle stop -> immediate STOPPED
  assert.equal(state.mining.status, STATUS.STOPPED);
});

test("requestAction: restart goes STOPPING -> ... -> STARTING with a fresh child", async () => {
  const { manager: m, state } = makeManager({ MOCK_MODE: "quiet" }, { restartGap: 50 });
  try {
    await m.start();
    assert.ok(await waitFor(() => state.miner.running && state.miner.pid > 0));
    const pid1 = state.miner.pid;
    m.requestAction("restart");
    await settle(600);
    assert.equal(state.mining.status, STATUS.RESTARTING, "UI-facing status flips immediately");
    assert.ok(await waitFor(() => state.miner.running && state.miner.pid !== pid1, 12000, 50), "miner back up after restart");
    assert.notEqual(state.miner.pid, pid1, "a fresh child was spawned");
  } finally {
    await m.stop();
  }
});

test("stats are reset between runs", async () => {
  const { manager: m, state } = makeManager({ MOCK_MODE: "silent" });
  try {
    await m.start();
    assert.ok(await waitFor(() => state.miner.running));
    Object.assign(state.mining, { hashrateKHs: 5, accepted: 9, submitted: 9 });
    await m.stop();
    m.requestAction("start");
    assert.ok(await waitFor(() => state.miner.running, 8000, 100), "second run started");
    assert.equal(state.mining.hashrateKHs, null, "stale hashrate must not survive a restart");
    assert.equal(state.mining.accepted, 0);
  } finally {
    await m.stop();
    m.dispose();
  }
});

test("force-kill watchdog handles a miner that ignores SIGINT", async () => {
  const { manager: m, state } = makeManager({ MOCK_IGNORE_SIGINT: "1", MOCK_MODE: "quiet" }, { forceKill: 400, stop: 900 });
  await m.start();
  assert.ok(await waitFor(() => state.miner.running));
  await m.stop();
  await settle(1600);
  assert.equal(state.mining.status, STATUS.STOPPED);
  assert.equal(m.isStoppingChild, false);
});

test("parsing gate: enableParsing/disableParsing control broadcast work", async () => {
  const { manager: m, state } = makeManager({ MOCK_MODE: "healthy", MOCK_RATE_MS: "200" });
  let emits = 0;
  m.onUpdate = () => emits++;
  await m.start();
  assert.ok(await waitFor(() => state.miner.running));
  await settle(600);
  const before = emits;
  m.disableParsing();
  await settle(600);
  assert.equal(emits, before, "no emits while idle (state still parsed internally)");
  assert.ok(state.mining.hashrateKHs !== undefined, "counters still maintained for late attachers");
  m.enableParsing();
  await settle(400);
  assert.ok(emits > before);
  await m.stop();
});
