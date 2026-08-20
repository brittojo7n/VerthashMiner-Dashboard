import { test } from "node:test";
import assert from "node:assert/strict";
import {
  presentSnapshot, presentGpu, sharesPerMinute, uptime, timestamp, dotClass, num
} from "../../public/js/present.js";

test("presentSnapshot: metric projection the DOM receives", () => {
  const snap = {
    now: 1755710000000,
    startedAt: 1755709000000,
    acceptedRatio: 87.5,
    host: { hostname: "RIG", tz: "UTC+05:30" },
    miner: { running: true, wallet: "VkcAbC" },
    mining: { hashrateKHs: 3.516, accepted: 7, submitted: 8, rejected: 1, difficulty: 0.0244140625, status: "MINING", lastAcceptedAt: 1755709999000 }
  };
  const d = presentSnapshot(snap);
  assert.equal(d.status, "MINING");
  assert.equal(d.hashrate, "3.52");
  assert.equal(d.accepted, "7 / 8");
  assert.equal(d.ratio, "87.50%");
  assert.equal(d.rejected, "1");
  assert.equal(d.difficulty, "0.0244140625");
  assert.equal(d.wallet, "VkcAbC");
  assert.equal(d.host, "Host: RIG");
  assert.match(d.lastAccepted, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, "formatted local time");
});

test("presentSnapshot: dead miner with stale live status shows STOPPED", () => {
  const d = presentSnapshot({ now: 0, acceptedRatio: null, host: { hostname: "h", tz: "" }, miner: { running: false, wallet: "" }, mining: { hashrateKHs: 1, accepted: 0, submitted: 0, rejected: 0, difficulty: null, status: "MINING", lastAcceptedAt: null } });
  assert.equal(d.status, "STOPPED");
  assert.equal(d.accepted, "\u2014");
  assert.equal(d.hashrate, "1.00");
});

test("presentSnapshot: pending UI action overrides displayed status", () => {
  const snap = { now: 0, acceptedRatio: null, host: { hostname: "h", tz: "" }, miner: { running: true, wallet: "" }, mining: { status: "MINING", hashrateKHs: null, accepted: 0, submitted: 0, rejected: 0, difficulty: null, lastAcceptedAt: null } };
  assert.equal(presentSnapshot(snap, { pendingStatus: "RESTARTING" }).status, "RESTARTING");
});

test("presentGpu: card projection with efficiency and clamped utilisation", () => {
  const g = presentGpu({ index: 0, name: "RTX 3060", temperatureC: 84, powerW: 120, utilizationPct: 97, coreMHz: 1710, memoryMHz: 6801, memoryUsedMB: 8000, memoryTotalMB: 12288, pstate: "P2", hashrate: 1.98 });
  assert.equal(g.name, "GPU 0 \u2022 RTX 3060");
  assert.equal(g.temp, "84\u00b0C");
  assert.equal(g.tempClass, "red", ">=80C is red");
  assert.equal(g.eff, "0.02", "1.98 kH/s over 120 W");
  assert.equal(g.util, "97");
  assert.equal(g.barWidth, "97%");
  const cold = presentGpu({ index: 0, temperatureC: 50 });
  assert.equal(cold.tempClass, "green");
  const hot = presentGpu({ index: 0, temperatureC: 73 });
  assert.equal(hot.tempClass, "yellow");
  const none = presentGpu({ index: 0, hashrate: null, powerW: null });
  assert.equal(none.hashrate, "\u2014");
  assert.equal(none.eff, "\u2014");
  const clamp = presentGpu({ index: 0, utilizationPct: 250 });
  assert.equal(clamp.barWidth, "100%");
});

test("uptime / sharesPerMinute / timestamp formatting", () => {
  assert.equal(uptime(0), "00:00:00");
  assert.equal(uptime(3725), "01:02:05");
  assert.equal(uptime(90061), "1d 1h 1m");
  assert.equal(sharesPerMinute(10, 120000), "5.000");
  assert.equal(sharesPerMinute(0, 60000), "\u2014");
  assert.equal(num(null), "\u2014");
  assert.equal(num(1.005, 2), "1.00");
});

test("dotClass: status colour buckets", () => {
  assert.equal(dotClass("MINING"), "dot ok");
  assert.equal(dotClass("CONNECTED"), "dot ok");
  assert.equal(dotClass("STOPPED"), "dot err");
  assert.equal(dotClass("CRASHED"), "dot err");
  assert.equal(dotClass("STARTING"), "dot warn");
  assert.equal(dotClass("DISCONNECTED"), "dot warn");
});
