"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { CircularLogBuffer, createState, formatStatsSnapshot } = require("../../src/state");
const { feed, markRunning } = require("../helpers/harness");
const { SESSION_LINES, log, device } = require("../helpers/fixtures");

test("ring buffer keeps the newest N lines in order with stable ids", () => {
  const buf = new CircularLogBuffer(3);
  for (let i = 1; i <= 10; i++) buf.push(`line ${i}`, "info");

  const all = buf.toJSON();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map(e => e.text), ["line 8", "line 9", "line 10"]);
  assert.deepEqual(all.map(e => e.id), [8, 9, 10]);
  assert.equal(buf.seq, 10);
  assert.equal(buf.firstId, 8);
});

test("since() returns only newer entries and self-heals on gaps", () => {
  const buf = new CircularLogBuffer(5);
  for (let i = 1; i <= 5; i++) buf.push(`l${i}`);

  assert.deepEqual(buf.since(5).map(e => e.id), []);
  assert.deepEqual(buf.since(3).map(e => e.id), [4, 5]);
  assert.deepEqual(buf.since(0).map(e => e.id), [1, 2, 3, 4, 5]);

  for (let i = 6; i <= 12; i++) buf.push(`l${i}`);
  // Consumer is far behind the retention window: everything retained is sent.
  assert.deepEqual(buf.since(2).map(e => e.id), [8, 9, 10, 11, 12]);
  assert.deepEqual(buf.since(-1).map(e => e.id), [8, 9, 10, 11, 12]);
});

test("every delta chain reconstructs the full log exactly once", () => {
  const buf = new CircularLogBuffer(64);
  const seen = [];
  let cursor = 0;

  for (let i = 1; i <= 200; i++) {
    buf.push(`line ${i}`);
    if (i % 7 === 0) {
      for (const entry of buf.since(cursor)) seen.push(entry.id);
      cursor = buf.seq;
    }
  }
  for (const entry of buf.since(cursor)) seen.push(entry.id);

  assert.deepEqual(seen, Array.from({ length: 200 }, (_, i) => i + 1), "no gaps, no duplicates");
});

test("snapshot exposes the metrics the UI binds to", () => {
  const state = markRunning(createState("vtc1qtest", 50));
  feed(SESSION_LINES, state);

  const snap = formatStatsSnapshot(state);
  assert.equal(snap.mining.accepted, 2);
  assert.equal(snap.mining.submitted, 3);
  assert.equal(snap.mining.rejected, 1);
  assert.equal(snap.acceptedRatio, (2 / 3) * 100);
  assert.equal(snap.miner.wallet, "vtc1qtest");
  assert.equal(snap.logCapacity, 50);
  assert.equal(snap.logCount, snap.miner.logs.length);
  assert.ok(snap.uptimeSeconds >= 0);
});

test("snapshot deltas only carry new console lines", () => {
  const state = markRunning(createState("w", 50));
  feed(SESSION_LINES.slice(0, 5), state, (t, ty) => state.miner.logs.push(t, ty));

  const first = formatStatsSnapshot(state);
  assert.ok(first.miner.logs.length > 0);

  const second = formatStatsSnapshot(state, { logsSince: first.logSeq });
  assert.equal(second.miner.logs.length, 0);
  assert.equal(second.logSeq, first.logSeq);
  assert.equal(second.logCount, first.logCount);
});

test("GPU hashrate is joined by PCI id, not by enumeration order", () => {
  const state = markRunning(createState("w", 20));
  // nvidia-smi order is reversed relative to CUDA enumeration.
  state.gpu = [
    { index: 0, name: "B", pciBusId: "08:00:0" },
    { index: 1, name: "A", pciBusId: "01:00:0" }
  ];
  state.mining.pciMap["01:00:0"] = "0";
  state.mining.pciMap["08:00:0"] = "1";

  feed([log("INFO", device("cu", 0, 111.11)), log("INFO", device("cu", 1, 222.22))], state);

  const snap = formatStatsSnapshot(state);
  assert.equal(snap.gpu[0].hashrate, 222.22, "PCI 08:00:0 is CUDA device 1");
  assert.equal(snap.gpu[1].hashrate, 111.11, "PCI 01:00:0 is CUDA device 0");
});

test("GPU hashrate falls back to positional index without a PCI map", () => {
  const state = markRunning(createState("w", 20));
  state.gpu = [{ index: 0, name: "A", pciBusId: "unknown" }];
  feed([log("INFO", device("cu", 0, 42.5))], state);
  assert.equal(formatStatsSnapshot(state).gpu[0].hashrate, 42.5);
});

test("snapshot is JSON-serialisable and free of cycles", () => {
  const state = markRunning(createState("w", 20));
  feed(SESSION_LINES, state);
  const text = JSON.stringify(formatStatsSnapshot(state));
  assert.ok(text.length > 100);
  assert.doesNotThrow(() => JSON.parse(text));
});
