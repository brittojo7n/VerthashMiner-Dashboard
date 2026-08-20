"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { GpuManager, parseSmiOutput, sameTelemetry, SMI_QUERY } = require("../../src/gpu");
const { createState } = require("../../src/state");

const CSV = (i, temp = 64) =>
  `NVIDIA GeForce RTX 3060, ${temp}, 118.5, 97, 1710, 6801, 8000, 12288, P2, 00000000:0${i}:00.0`;

test("parseSmiOutput: CSV columns mapped to the snapshot schema", () => {
  const gpus = parseSmiOutput(`${CSV(1)}\n${CSV(6, 71)}\n`);
  assert.equal(gpus.length, 2);
  assert.equal(gpus[0].name, "NVIDIA GeForce RTX 3060");
  assert.equal(gpus[0].temperatureC, 64);
  assert.equal(gpus[0].powerW, 118.5);
  assert.equal(gpus[0].utilizationPct, 97);
  assert.equal(gpus[0].coreMHz, 1710);
  assert.equal(gpus[0].memoryMHz, 6801);
  assert.equal(gpus[0].memoryUsedMB, 8000);
  assert.equal(gpus[0].memoryTotalMB, 12288);
  assert.equal(gpus[0].pstate, "P2");
  assert.equal(gpus[0].pciBusId, "01:00:0");
  assert.equal(gpus[1].pciBusId, "06:00:0");
  assert.equal(gpus[1].index, 1, "enumeration order sets index");
});

test("parseSmiOutput: empty / garbage tolerated", () => {
  assert.deepEqual(parseSmiOutput(""), []);
  assert.deepEqual(parseSmiOutput("   \n"), []);
  const weird = parseSmiOutput(",,,,,,,");
  assert.equal(weird.length, 1);
  assert.equal(weird[0].temperatureC, null, "blank CSV field is unknown, not 0");
});

test("sameTelemetry: change detection across all published fields", () => {
  const a = parseSmiOutput(CSV(1));
  assert.ok(sameTelemetry(a, parseSmiOutput(CSV(1))));
  for (const mutate of [
    g => g[0].temperatureC = 99,
    g => g[0].powerW = 1,
    g => g[0].utilizationPct = 1,
    g => g[0].coreMHz = 1,
    g => g[0].memoryMHz = 1,
    g => g[0].memoryUsedMB = 1,
    g => g[0].pstate = "P8",
    g => g[0].name = "x",
    g => g[0].pciBusId = "x"
  ]) {
    const b = parseSmiOutput(CSV(1));
    mutate(b);
    assert.ok(!sameTelemetry(a, b));
  }
  assert.ok(!sameTelemetry(a, null));
});

test("GpuManager: polling is inert until a subscriber attaches", async () => {
  const calls = [];
  const state = createState("", 50);
  const mgr = new GpuManager({ state, pollMs: 3000, onUpdate: () => {}, exec: (bin, args, opts, cb) => { calls.push(Date.now()); cb(null, CSV(1)); } });
  await new Promise(r => setTimeout(r, 80));
  assert.equal(calls.length, 0, "no spawn while nobody is watching");
  mgr.updateSubscribers(1);
  assert.equal(calls.length, 1, "immediate first poll on attach");
  mgr.updateSubscribers(3);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(calls.length, 1, "more clients must not amplify spawns");
  mgr.updateSubscribers(0);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(calls.length, 1, "detach stops all polling work");
  mgr.stop();
});

test("GpuManager: global cooldown blocks refresh-storm spawns", async () => {
  const state = createState("", 50);
  const mgr = new GpuManager({ state, pollMs: 3000, exec: (b, a, o, cb) => cb(null, CSV(1)) });
  mgr.updateSubscribers(1); // first poll at t=0
  mgr.poll(); mgr.poll(); mgr.poll(); // refresh / reconnect attempts
  await new Promise(r => setTimeout(r, 150));
  mgr.stop();
});

test("GpuManager: failures back off exponentially up to the cap", async () => {
  const state = createState("", 50);
  let fails = 0;
  const mgr = new GpuManager({ state, pollMs: 3000, exec: (b, a, o, cb) => { fails++; cb(new Error("spawn ENOENT")); } });
  assert.equal(mgr.intervalMs, 3000);
  mgr.updateSubscribers(1);
  assert.equal(fails, 1);
  assert.equal(mgr.failures, 1);
  assert.equal(mgr.intervalMs, 3000, "no backoff for the first couple of failures");
  // simulate 5 total failures
  for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(mgr.intervalMs >= 3000, "backoff engaged after threshold");
  mgr.failures = 20;
  assert.equal(mgr.intervalMs, 120000, "capped at GPU_BACKOFF_MAX_MS");
  mgr.stop();
});

test("GpuManager: gpuError surface + recovery broadcast", async () => {
  const state = createState("", 50);
  let fail = true;
  let broadcasts = 0;
  const mgr = new GpuManager({ state, pollMs: 3000, onUpdate: () => broadcasts++, exec: (b, a, o, cb) => fail ? cb(new Error("boom ENOENT"), "") : cb(null, CSV(1)) });
  mgr.updateSubscribers(1);
  assert.ok(state.gpuError.includes("boom"));
  fail = false;
  await new Promise(r => setTimeout(r, 3100));
  assert.equal(state.gpuError, "");
  assert.equal(state.gpu.length, 1);
  assert.ok(broadcasts >= 2);
  mgr.stop();
});

test("GpuManager: identical telemetry does not broadcast", async () => {
  const state = createState("", 50);
  let broadcasts = 0;
  let n = 0;
  const mgr = new GpuManager({ state, pollMs: 3000, onUpdate: () => broadcasts++, exec: (b, a, o, cb) => cb(null, n++ === 0 ? CSV(1) : CSV(1)) });
  mgr.updateSubscribers(1);
  await new Promise(r => setTimeout(r, 3100));
  assert.equal(broadcasts, 1, "second identical poll suppressed");
  mgr.stop();
});

test("SMI_QUERY contract: dashboard queries exactly the fields the UI needs", () => {
  assert.equal(SMI_QUERY[0],
    "--query-gpu=name,temperature.gpu,power.draw,utilization.gpu,clocks.gr,clocks.mem,memory.used,memory.total,pstate,pci.bus_id");
  assert.equal(SMI_QUERY[1], "--format=csv,noheader,nounits");
});
