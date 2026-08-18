"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { createState, formatStatsSnapshot } = require("../../src/state");
const { feed, markRunning, ROOT } = require("../helpers/harness");
const { reduceLog } = require("../helpers/oracle");
const { SESSION_LINES, log, device, share } = require("../helpers/fixtures");

const importUi = name => import(pathToFileURL(path.join(ROOT, "public", "js", name)).href);

const DASH = "\u2014";

test("format helpers render the documented shapes", async () => {
  const { num, uptime, timestamp } = await importUi("format.js");

  assert.equal(num(419.7812, 2), "419.78");
  assert.equal(num(null), DASH);
  assert.equal(num(undefined), DASH);
  assert.equal(num(NaN), DASH);
  assert.equal(num(Infinity), DASH);
  assert.equal(num(0, 2), "0.00", "zero is a value, not a blank");

  assert.equal(uptime(0), "00:00:00");
  assert.equal(uptime(59), "00:00:59");
  assert.equal(uptime(3661), "01:01:01");
  assert.equal(uptime(90061), "1d 1h 1m");
  assert.equal(uptime(-5), "00:00:00");

  assert.match(timestamp(Date.UTC(2026, 7, 18, 20, 0, 0)), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(timestamp(Date.now(), "UTC+05:30"), /\(UTC\+05:30\)$/);
});

test("UI strings equal the values implied by the console log", async () => {
  const { presentSnapshot } = await importUi("present.js");

  const state = markRunning(createState("vtc1qwddxt3rmwx00ev9yg4qcwpxnguw5zm7mwej2xk", 50));
  feed(SESSION_LINES, state);

  const snapshot = formatStatsSnapshot(state);
  const view = presentSnapshot(snapshot);
  const truth = reduceLog(SESSION_LINES);

  assert.equal(view.hashrate, truth.hashrateKHs.toFixed(2));
  assert.equal(view.accepted, `${truth.accepted} / ${truth.submitted}`);
  assert.equal(view.ratio, `${truth.acceptedRatio.toFixed(1)}%`);
  assert.equal(view.rejected, String(truth.rejected));
  assert.equal(view.difficulty, String(truth.difficulty));
  assert.equal(view.status, truth.status);
  assert.equal(view.wallet, "vtc1qwddxt3rmwx00ev9yg4qcwpxnguw5zm7mwej2xk");
});

test("empty state renders em dashes instead of zeros or NaN", async () => {
  const { presentSnapshot } = await importUi("present.js");
  const view = presentSnapshot(formatStatsSnapshot(createState("", 20)));

  assert.equal(view.hashrate, DASH);
  assert.equal(view.accepted, DASH);
  assert.equal(view.ratio, DASH);
  assert.equal(view.difficulty, DASH);
  assert.equal(view.lastAccepted, DASH);
  assert.equal(view.wallet, DASH);
  assert.equal(view.rejected, "0");
  assert.equal(view.status, "STOPPED");
});

test("a dead miner can never be displayed as mining", async () => {
  const { presentSnapshot, effectiveStatus } = await importUi("present.js");
  const state = markRunning(createState("w", 20));
  feed([log("INFO", device("cu", 0, 210.11)), log("INFO", share(1, 1, 210.11))], state);

  state.miner.running = false;
  const snapshot = formatStatsSnapshot(state);
  assert.equal(snapshot.mining.status, "MINING", "raw state still says MINING");
  assert.equal(effectiveStatus(snapshot, null), "STOPPED", "UI downgrades it");
  assert.equal(presentSnapshot(snapshot).status, "STOPPED");
  assert.equal(presentSnapshot(snapshot).dot, "dot err");
});

test("an optimistic action status wins until the server confirms", async () => {
  const { presentSnapshot } = await importUi("present.js");
  const snapshot = formatStatsSnapshot(markRunning(createState("w", 20)));
  const view = presentSnapshot(snapshot, { pendingStatus: "STOPPING" });
  assert.equal(view.status, "STOPPING");
  assert.equal(view.dot, "dot warn");
  assert.equal(view.actionLabel, "STOP");
});

test("shares per minute follows accepted shares over uptime", async () => {
  const { sharesPerMinute } = await importUi("present.js");
  assert.equal(sharesPerMinute(0, 60_000), DASH);
  assert.equal(sharesPerMinute(2, 60_000), "2.000");
  assert.equal(sharesPerMinute(1, 120_000), "0.500");
  assert.equal(sharesPerMinute(3, 0), "3.000", "no division by zero");
});

test("acceptance ratio and rejects stay consistent with the counters", async () => {
  const { presentSnapshot } = await importUi("present.js");
  const state = markRunning(createState("w", 20));
  feed([log("INFO", share(97, 100, 419.78))], state);

  const view = presentSnapshot(formatStatsSnapshot(state));
  assert.equal(view.accepted, "97 / 100");
  assert.equal(view.ratio, "97.0%");
  assert.equal(view.rejected, "3");
});

test("GPU card values match the telemetry sample", async () => {
  const { presentGpu } = await importUi("present.js");
  const view = presentGpu({
    index: 1,
    name: "NVIDIA GeForce RTX 3070",
    temperatureC: 68,
    powerW: 179.05,
    utilizationPct: 100,
    coreMHz: 1905,
    memoryMHz: 7000,
    memoryUsedMB: 5877,
    memoryTotalMB: 8192,
    pstate: "P2",
    hashrate: 209.79
  });

  assert.equal(view.name, "GPU 1 \u2022 NVIDIA GeForce RTX 3070");
  assert.equal(view.temp, "68\u00b0C");
  assert.equal(view.tempClass, "green");
  assert.equal(view.power, "179.1");
  assert.equal(view.hashrate, "209.79");
  assert.equal(view.eff, (209.79 / 179.05).toFixed(2));
  assert.equal(view.util, "100.0");
  assert.equal(view.barWidth, "100%");
});

test("GPU thresholds and missing readings degrade safely", async () => {
  const { presentGpu } = await importUi("present.js");
  const { tempClass } = await importUi("format.js");

  assert.equal(tempClass(71), "green");
  assert.equal(tempClass(72), "yellow");
  assert.equal(tempClass(79), "yellow");
  assert.equal(tempClass(80), "red");
  assert.equal(tempClass(null), "");

  const blank = presentGpu({ index: 0, name: "", pstate: null, temperatureC: null, hashrate: null });
  assert.equal(blank.name, "GPU 0 \u2022 Unknown");
  assert.equal(blank.temp, DASH);
  assert.equal(blank.hashrate, DASH);
  assert.equal(blank.eff, DASH);
  assert.equal(blank.barWidth, "0%");

  const insane = presentGpu({ index: 0, utilizationPct: 250, hashrate: 5, powerW: 0 });
  assert.equal(insane.barWidth, "100%", "utilisation is clamped");
  assert.equal(insane.eff, DASH, "no division by zero power");
});
