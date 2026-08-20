import { test } from "node:test";
import assert from "node:assert/strict";
import { createPerfGate } from "../../public/js/perf.js";

/* deterministic rAF clock the tests drive by hand */
function makeClock(start = 0) {
  const pending = new Map();
  const delayed = [];
  let nextId = 1;
  let now = start;
  return {
    raf(cb) {
      const id = nextId++;
      pending.set(id, cb);
      return () => pending.delete(id);
    },
    delay(cb) { delayed.push(cb); }, // probe deferral, flushed by the next tick
    tick(dt) {
      now += dt;
      const timers = delayed.splice(0);
      const run = [...pending.entries()];
      pending.clear();
      for (const [, cb] of run) cb(now);
      for (const cb of timers) cb();
    },
    get pendingCount() { return pending.size; },
    get now() { return now; }
  };
}

function env({ memory = 4, cores = 4, reducedMotion = false, updateSlow = false, sessionLock = null, visible = true } = {}) {
  const clock = makeClock();
  const classes = new Set();
  const storageMap = new Map(sessionLock ? [["vmd:fxLock", "1"]] : []);
  const modes = [];
  const api = createPerfGate({
    root: { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } },
    media: q => (q.includes("prefers-reduced-motion") ? reducedMotion : updateSlow),
    raf: clock.raf,
    delay: clock.delay,
    visible: () => visible,
    navigatorLike: { deviceMemory: memory, hardwareConcurrency: cores },
    storage: { get: k => storageMap.get(k) ?? null, set: (k, v) => storageMap.set(k, v), remove: k => storageMap.delete(k) },
    onChange: mode => modes.push(mode)
  });
  return { api, clock, classes, storageMap, modes };
}

test("gate: reduced motion locks lite forever", () => {
  const { api, clock } = env({ reducedMotion: true });
  api.start();
  clock.tick(16); clock.tick(16);
  assert.equal(api.gate.mode, "lite");
  assert.equal(api.gate.locked, true);
  assert.match(api.gate.reason, /reduced motion/);
});

test("gate: slow update locks lite", () => {
  const { api } = env({ updateSlow: true });
  api.start();
  assert.equal(api.gate.mode, "lite");
  assert.equal(api.gate.locked, true);
});

test("gate: prior governor demote is remembered per session", () => {
  const { api } = env({ sessionLock: true, memory: 8, cores: 8 });
  api.start();
  assert.equal(api.gate.mode, "lite", "even a desktop stays lite when this tab was demoted");
  assert.equal(api.gate.locked, true);
  assert.match(api.gate.reason, /session lock/);
});

test("gate: <=2 GB devices never probe", () => {
  const { api, clock } = env({ memory: 2 });
  api.start();
  for (let i = 0; i < 50; i++) clock.tick(16.7);
  assert.equal(api.gate.mode, "lite");
  assert.equal(api.gate.locked, true);
  assert.equal(clock.pendingCount, 0, "no probe frames scheduled");
});

test("gate: desktop class (>=8GB, >=8 cores) enables fx immediately, governor armed", () => {
  const { api, clock } = env({ memory: 8, cores: 8 });
  api.start();
  assert.equal(api.gate.mode, "fx");
  assert.equal(api.gate.locked, false);
  assert.ok(clock.pendingCount > 0, "governor sampling loop running");
});

test("gate: a 4GB tablet must EARN fx through the compositing probe", () => {
  const { api, clock } = env({ memory: 4, cores: 4 });
  api.start();
  assert.equal(api.gate.mode, "lite", "no instant upgrade for deviceMemory === 4");
  // healthy 60fps probe
  for (let i = 0; i < 50; i++) clock.tick(16.7);
  assert.equal(api.gate.mode, "fx", "probe passed at ~16.7ms frames");
  assert.match(api.gate.reason, /probe passed/);
});

test("gate: a 4GB tablet that cannot composite blur at 60fps stays lite", () => {
  const { api, clock } = env({ memory: 4, cores: 4 });
  api.start();
  for (let i = 0; i < 50; i++) clock.tick(38); // ~26fps under blur load
  assert.equal(api.gate.mode, "lite");
  assert.match(api.gate.reason, /probe failed/);
  assert.equal(api.gate.locked, false, "probe failure is not a session lock; next load retries");
});

test("governor: demotes fx and locks the session after two bad windows", () => {
  const { api, clock, storageMap } = env({ memory: 8, cores: 8 });
  api.start();
  assert.equal(api.gate.mode, "fx");
  // window 1: bad frames (~30ms median)
  for (let i = 0; i < 60; i++) clock.tick(30);
  assert.equal(api.gate.mode, "fx", "first strike alone does not demote");
  // window 2: still bad
  for (let i = 0; i < 60; i++) clock.tick(30);
  assert.equal(api.gate.mode, "lite", "two consecutive strikes demote");
  assert.match(api.gate.reason, /governor/);
  assert.equal(storageMap.get("vmd:fxLock"), "1", "lock persisted for this tab session");
  assert.equal(clock.pendingCount, 0, "governor loop stopped");
});

test("governor: a healthy window resets the strike count", () => {
  const { api, clock } = env({ memory: 8, cores: 8 });
  api.start();
  for (let i = 0; i < 60; i++) clock.tick(30);   // strike 1
  for (let i = 0; i < 100; i++) clock.tick(16.7); // healthy window resets
  for (let i = 0; i < 60; i++) clock.tick(30);   // strike 1 again
  assert.equal(api.gate.mode, "fx", "non-consecutive strikes do not demote");
});

test("governor: hidden tab (sparse frames) is not punished", () => {
  const { api, clock } = env({ memory: 8, cores: 8 });
  api.start();
  for (let i = 0; i < 20; i++) clock.tick(1000); // 1fps: rAF starved, few samples
  assert.equal(api.gate.mode, "fx", "windows without enough samples are ignored");
});

test("probe: hidden page defers the probe instead of skipping it", () => {
  const clock = makeClock();
  const classes = new Set();
  let isVisible = false;
  let deferred = null;
  const api = createPerfGate({
    root: { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } },
    media: () => false,
    raf: clock.raf,
    delay: clock.delay,
    visible: () => isVisible,
    navigatorLike: { deviceMemory: 4, hardwareConcurrency: 4 },
    storage: { get: () => null, set: () => { }, remove: () => { } },
    onVisible: cb => { deferred = cb; }
  });
  api.start();
  for (let i = 0; i < 30; i++) clock.tick(16.7);
  assert.equal(api.gate.mode, "lite");
  assert.equal(clock.pendingCount, 0, "nothing measured while hidden");
  assert.ok(deferred, "probe deferred until visible");
  isVisible = true;
  deferred();
  assert.equal(clock.pendingCount, 1, "probe armed once visible");
  for (let i = 0; i < 50; i++) clock.tick(16.7);
  assert.equal(api.gate.mode, "fx", "deferred probe ran and passed");
});

test("judgeWindow thresholds", () => {
  const { api } = env({});
  const ok = Array.from({ length: 60 }, () => 16.5);
  const bad = Array.from({ length: 60 }, () => 30);
  const jittery = [...Array.from({ length: 58 }, () => 16.5), 60, 70]; // p95 high, median fine
  assert.ok(api.judgeWindow(ok) < 0, "60fps window is healthy");
  assert.ok(api.judgeWindow(bad) > 0, "30fps median is a strike");
  assert.ok(api.judgeWindow(jittery) < 0, "isolated long frames with a fine median are tolerated");
  assert.ok(api.judgeWindow([16, 16]) < 0, "too few samples is not a strike");
});
