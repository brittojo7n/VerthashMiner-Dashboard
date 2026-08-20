"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CircularLogBuffer, createState, formatStatsSnapshot, hashrateForGpu } = require("../../src/state");
const { STATUS } = require("../../src/constants");

test("CircularLogBuffer: ring semantics", () => {
  const b = new CircularLogBuffer(3);
  b.push("a"); b.push("b");
  assert.deepEqual(b.toJSON().map(e => e.text), ["a", "b"]);
  b.push("c"); b.push("d"); // wraps, drops "a"
  assert.deepEqual(b.toJSON().map(e => e.text), ["b", "c", "d"]);
  assert.equal(b.length, 3);
  assert.equal(b.firstId, 2, "firstId = seq - count + 1");
});

test("CircularLogBuffer: since() incremental reads", () => {
  const b = new CircularLogBuffer(50);
  for (let i = 0; i < 10; i++) b.push(`line${i}`);
  assert.equal(b.since(8).length, 2, "ids 9,10 are new");
  assert.deepEqual(b.since(8).map(e => e.text), ["line8", "line9"]);
  assert.equal(b.since(10).length, 0, "nothing new");
  assert.equal(b.since(0).length, 10, "since(0) = full replay");
  assert.equal(b.since(-5).length, 10);
});

test("CircularLogBuffer: since() beyond capacity degrades to full replay", () => {
  const b = new CircularLogBuffer(3);
  for (let i = 0; i < 100; i++) b.push(`x${i}`);
  // seq=100, only last 3 retained; asking for since(1) misses everything
  assert.equal(b.since(1).length, 3);
  assert.equal(b.since(1)[0].text, "x97");
});

test("CircularLogBuffer: clear resets everything", () => {
  const b = new CircularLogBuffer(3);
  b.push("a"); b.clear();
  assert.equal(b.length, 0);
  assert.equal(b.firstId, 0);
  assert.deepEqual(b.toJSON(), []);
});

test("formatStatsSnapshot: projected shape and derived fields", () => {
  const s = createState("VkcWallet", 50);
  s.miner.running = true;
  s.miner.startedAt = Date.now() - 91500;
  Object.assign(s.mining, { hashrateKHs: 3.5, accepted: 7, submitted: 8, rejected: 1, difficulty: 0.5, status: STATUS.MINING });
  s.miner.logs.push("hello", "info");
  const snap = formatStatsSnapshot(s);
  assert.equal(snap.uptimeSeconds, 91);
  assert.equal(snap.acceptedRatio, 87.5);
  assert.equal(snap.mining.hashrateKHs, 3.5);
  assert.equal(snap.miner.logs[0].text, "hello");
  assert.equal(snap.logsFrom, 1);
  assert.equal(snap.logSeq, 1);
  assert.equal(snap.logCount, 1);
  assert.equal(snap.logCapacity, 50);
  assert.ok(snap.host.hostname.length > 0 && /UTC[+-]/.test(snap.host.tz));
});

test("formatStatsSnapshot: logsSince returns only new entries", () => {
  const s = createState("", 50);
  s.miner.logs.push("a", "info");
  s.miner.logs.push("b", "info");
  const snap = formatStatsSnapshot(s, { logsSince: 1 });
  assert.deepEqual(snap.miner.logs.map(e => e.text), ["b"]);
  assert.equal(snap.logsFrom, 2);
  const none = formatStatsSnapshot(s, { logsSince: 2 });
  assert.equal(none.miner.logs.length, 0);
  assert.equal(none.logsFrom, 3, "logsFrom = seq + 1 when empty");
});

test("formatStatsSnapshot: stopped miner reports zero uptime", () => {
  const s = createState("", 50);
  s.miner.startedAt = Date.now() - 50000;
  assert.equal(formatStatsSnapshot(s).uptimeSeconds, 0);
});

test("hashrateForGpu: PCI bus id join with positional fallback", () => {
  const s = createState("", 50);
  s.mining.pciMap["06:00:0"] = 1; // nvidia-smi position 1 -> CUDA index 1
  s.mining.gpuHashrates = { cu_0: 1.1, cu_1: 2.2 };
  const gte = { index: 0, pciBusId: "01:00:0" };
  const gtx = { index: 1, pciBusId: "06:00:0" };
  assert.equal(hashrateForGpu(s, gte), 1.1, "unmapped -> positional index");
  assert.equal(hashrateForGpu(s, gtx), 2.2, "mapped -> cuda index from probe");
});

test("hashrateForGpu: falls back to OpenCL rate when CUDA missing", () => {
  const s = createState("", 50);
  s.mining.gpuHashrates = { cl_0: 0.7 };
  assert.equal(hashrateForGpu(s, { index: 0, pciBusId: "" }), 0.7);
});

test("snapshot: gpu array is a projection with hashrate attached", () => {
  const s = createState("", 50);
  s.gpu = [{ index: 0, name: "RTX 3060", temperatureC: 64, powerW: 118, utilizationPct: 97, coreMHz: 1710, memoryMHz: 6801, memoryUsedMB: 8000, memoryTotalMB: 12288, pstate: "P2", pciBusId: "01:00:0" }];
  s.mining.gpuHashrates = { cu_0: 1.9 };
  const snap = formatStatsSnapshot(s);
  assert.equal(snap.gpu.length, 1);
  assert.equal(snap.gpu[0].hashrate, 1.9);
  assert.equal(snap.gpu[0].name, "RTX 3060");
});
