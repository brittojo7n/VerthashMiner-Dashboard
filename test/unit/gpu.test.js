"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { GpuManager, parseSmiOutput, sameTelemetry, SMI_BIN, SMI_QUERY } = require("../../src/gpu");
const { createState } = require("../../src/state");
const { SMI_OUTPUT } = require("../helpers/fixtures");
const { LIMITS } = require("../../src/constants");
const { delay } = require("../helpers/harness");

test("nvidia-smi CSV maps to telemetry fields", () => {
  const gpus = parseSmiOutput(SMI_OUTPUT);
  assert.equal(gpus.length, 2);
  assert.deepEqual(gpus[0], {
    index: 0,
    name: "NVIDIA GeForce RTX 3060",
    temperatureC: 63,
    powerW: 118.42,
    utilizationPct: 99,
    coreMHz: 1830,
    memoryMHz: 7300,
    memoryUsedMB: 4021,
    memoryTotalMB: 12288,
    pstate: "P2",
    pciBusId: "01:00:0"
  });
  assert.equal(gpus[1].pciBusId, "08:00:0");
});

test("unsupported readings become null instead of zero", () => {
  const [gpu] = parseSmiOutput(
    "NVIDIA T400, [N/A], [Not Supported], 0, 1000, [N/A], 12, 2048, P8, 00000000:02:00.0"
  );
  assert.equal(gpu.temperatureC, null);
  assert.equal(gpu.powerW, null);
  assert.equal(gpu.utilizationPct, 0, "a real zero must survive");
  assert.equal(gpu.memoryMHz, null);
});

test("blank, partial and hostile smi output is tolerated", () => {
  assert.deepEqual(parseSmiOutput(""), []);
  assert.deepEqual(parseSmiOutput("\n\n"), []);
  assert.equal(parseSmiOutput("only-a-name").length, 1);
  assert.doesNotThrow(() => parseSmiOutput("\u0000,\u0001,\u0002"));
  assert.equal(parseSmiOutput(SMI_OUTPUT.replace(/\n/g, "\r\n")).length, 2);
});

test("telemetry comparison detects real changes only", () => {
  const a = parseSmiOutput(SMI_OUTPUT);
  const b = parseSmiOutput(SMI_OUTPUT);
  assert.equal(sameTelemetry(a, b), true);
  b[1].temperatureC = 70;
  assert.equal(sameTelemetry(a, b), false);
  assert.equal(sameTelemetry(a, a.slice(0, 1)), false);
});

test("the poller is idle until a client attaches and stops again after", async () => {
  const state = createState("w", 20);
  let calls = 0;
  const gpu = new GpuManager({
    state,
    pollMs: 3000,
    onUpdate: () => {},
    exec: (_bin, _args, _opts, cb) => {
      calls++;
      cb(null, SMI_OUTPUT);
    }
  });

  await delay(30);
  assert.equal(calls, 0, "no polling without subscribers");

  gpu.updateSubscribers(1);
  await delay(30);
  assert.equal(calls, 1);
  assert.equal(state.gpu.length, 2);

  gpu.updateSubscribers(0);
  assert.equal(gpu.timer, null, "no timer left armed");
  gpu.stop();
});

test("extra subscribers cannot amplify the spawn rate", async () => {
  const state = createState("w", 20);
  let calls = 0;
  const gpu = new GpuManager({
    state,
    pollMs: 3000,
    exec: (_b, _a, _o, cb) => {
      calls++;
      cb(null, SMI_OUTPUT);
    }
  });

  for (let i = 1; i <= 8; i++) gpu.updateSubscribers(i);
  gpu.poll();
  gpu.poll();
  await delay(50);

  assert.equal(calls, 1, "global cooldown holds");
  gpu.stop();
});

test("unchanged telemetry does not wake the broadcaster", async () => {
  const state = createState("w", 20);
  let updates = 0;
  const gpu = new GpuManager({
    state,
    pollMs: 3000,
    onUpdate: () => updates++,
    exec: (_b, _a, _o, cb) => cb(null, SMI_OUTPUT)
  });

  gpu.updateSubscribers(1);
  await delay(20);
  assert.equal(updates, 1);

  gpu.lastPollAt = 0;
  gpu.poll();
  await delay(20);
  assert.equal(updates, 1, "identical sample must not trigger a broadcast");
  gpu.stop();
});

test("a permanently failing nvidia-smi backs off instead of spawning forever", async () => {
  const state = createState("w", 20);
  const gpu = new GpuManager({
    state,
    pollMs: 3000,
    exec: (_b, _a, _o, cb) => cb(Object.assign(new Error("spawn nvidia-smi ENOENT"), { code: "ENOENT" }))
  });

  gpu.updateSubscribers(1);
  await delay(20);
  assert.match(state.gpuError, /ENOENT/);

  for (let i = 0; i < 10; i++) {
    gpu.lastPollAt = 0;
    gpu.poll();
    await delay(5);
  }
  assert.ok(gpu.failures >= LIMITS.GPU_FAILURE_BACKOFF_AFTER);
  assert.ok(gpu.intervalMs > 3000, "interval must grow");
  assert.ok(gpu.intervalMs <= LIMITS.GPU_BACKOFF_MAX_MS);
  gpu.stop();
});

test("the GPU error is reported once, not on every poll", async () => {
  const state = createState("w", 20);
  let updates = 0;
  const gpu = new GpuManager({
    state,
    pollMs: 3000,
    onUpdate: () => updates++,
    exec: (_b, _a, _o, cb) => cb(new Error("boom"))
  });

  gpu.updateSubscribers(1);
  await delay(20);
  for (let i = 0; i < 5; i++) {
    gpu.lastPollAt = 0;
    gpu.poll();
    await delay(5);
  }
  assert.equal(updates, 1);
  gpu.stop();
});

test("the query is read-only and creates no GPU context", () => {
  assert.match(SMI_BIN, /^nvidia-smi(\.exe)?$/);
  assert.equal(SMI_QUERY.length, 2);
  assert.ok(SMI_QUERY[0].startsWith("--query-gpu="));
  assert.ok(SMI_QUERY[1].startsWith("--format=csv"));
  // Nothing that would allocate device memory, change state or loop forever.
  const joined = SMI_QUERY.join(" ");
  for (const forbidden of ["-l", "--loop", "-pm", "--persistence-mode", "-i ", "--gpu-reset", "-ac", "--applications-clocks"]) {
    assert.ok(!joined.includes(forbidden), `must not use ${forbidden}`);
  }
});
