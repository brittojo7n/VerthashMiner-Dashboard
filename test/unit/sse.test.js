"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { SseHub } = require("../../src/sse");
const { createState } = require("../../src/state");
const { LIMITS } = require("../../src/constants");

function fakeRes() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.written = "";
  res.write = function (payload) { this.written += payload; return true; };
  res.end = function () { this.writableEnded = true; };
  res.socket = { destroyed: false, writable: true };
  res.req = new EventEmitter();
  return res;
}
function parseFrames(written) {
  return written.split("\n\n").filter(Boolean).map(block => {
    const data = block.split("\n").find(l => l.startsWith("data: "));
    return data ? JSON.parse(data.slice(6)) : null;
  }).filter(Boolean);
}
const flush = () => new Promise(r => setTimeout(r, LIMITS.BROADCAST_MS + 60));

test("SseHub: first frame is a full snapshot; later frames are incremental", async () => {
  const state = createState("", 50);
  const hub = new SseHub({ state });
  const res = fakeRes();
  hub.handleConnection(res.req, res);
  const first = parseFrames(res.written);
  assert.equal(first.length, 1);
  state.miner.logs.push("line1", "info");
  state.dirty = true;
  hub.broadcast();
  await flush();
  const frames = parseFrames(res.written);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[1].miner.logs.map(e => e.text), ["line1"], "only new lines shipped");
  assert.equal(frames[1].logsFrom, 1);
  hub.closeAll();
});

test("SseHub: broadcasts are coalesced within BROADCAST_MS", async () => {
  const state = createState("", 50);
  const hub = new SseHub({ state });
  const res = fakeRes();
  hub.handleConnection(res.req, res);
  for (let i = 0; i < 20; i++) { state.miner.logs.push(`l${i}`, "info"); state.dirty = true; hub.broadcast(); }
  await flush();
  const frames = parseFrames(res.written);
  assert.equal(frames.length, 2, "20 rapid mutations collapse into one frame");
  assert.equal(frames[1].miner.logs.length, 20);
  hub.closeAll();
});

test("SseHub: dirty flag gates fan-out", async () => {
  const state = createState("", 50);
  const hub = new SseHub({ state });
  const res = fakeRes();
  hub.handleConnection(res.req, res);
  const len = res.written.length;
  hub.broadcast();
  await flush();
  assert.equal(res.written.length, len, "no dirty state -> no frame");
  hub.closeAll();
});

test("SseHub: subscriber callback drives the zero-idle gate", () => {
  const counts = [];
  const state = createState("", 50);
  const hub = new SseHub({ state, onSubscriberChange: n => counts.push(n) });
  const a = fakeRes(), b = fakeRes();
  hub.handleConnection(a.req, a);
  hub.handleConnection(b.req, b);
  a.req.emit("close");
  b.req.emit("close");
  assert.deepEqual(counts, [1, 2, 1, 0]);
});

test("SseHub: 5th client rejected with an event stream", () => {
  const state = createState("", 50);
  const hub = new SseHub({ state });
  const clients = [];
  for (let i = 0; i < LIMITS.MAX_SSE_CLIENTS; i++) { const r = fakeRes(); clients.push(r); hub.handleConnection(r.req, r); }
  const extra = fakeRes();
  assert.equal(hub.handleConnection(extra.req, extra), false);
  assert.ok(extra.written.includes("event: rejected"));
});

test("SseHub: blocked slow client is dropped after the tick budget", async () => {
  const state = createState("", 50);
  const hub = new SseHub({ state });
  const slow = fakeRes();
  let drained = 0;
  slow.write = () => false; // never drains
  slow.once = (ev, fn) => { if (ev === "drain") drained++; return slow; };
  slow.on = slow.once;
  hub.handleConnection(slow.req, slow);
  assert.equal(hub.size, 1);
  for (let i = 0; i < LIMITS.SSE_MAX_BLOCKED_TICKS; i++) {
    state.miner.logs.push(`l${i}`, "info");
    state.dirty = true;
    hub.broadcast();
    await flush();
  }
  assert.equal(hub.size, 0, "blocked client evicted");
  hub.closeAll();
});

test("SseHub: heartbeat written on the shared timer", async () => {
  const state = createState("", 50);
  const hub = new SseHub({ state });
  const res = fakeRes();
  hub.handleConnection(res.req, res);
  await new Promise(r => setTimeout(r, LIMITS.HEARTBEAT_MS + 60));
  assert.ok(res.written.includes(": hb"), "heartbeat frame present");
  hub.closeAll();
});

test("SseHub: closeAll ends every client and reports zero subscribers", () => {
  const counts = [];
  const state = createState("", 50);
  const hub = new SseHub({ state, onSubscriberChange: n => counts.push(n) });
  const a = fakeRes(), b = fakeRes();
  hub.handleConnection(a.req, a);
  hub.handleConnection(b.req, b);
  hub.closeAll();
  assert.equal(hub.size, 0);
  assert.equal(a.writableEnded && b.writableEnded, true);
  assert.equal(counts[counts.length - 1], 0);
});

test("SseHub: reconnecting client receives only what it missed", async () => {
  const state = createState("", 50);
  const hub = new SseHub({ state });
  const res = fakeRes();
  hub.handleConnection(res.req, res);
  for (let i = 0; i < 5; i++) { state.miner.logs.push(`l${i}`, "info"); }
  state.dirty = true;
  hub.broadcast();
  await flush();
  const frames = parseFrames(res.written);
  assert.equal(frames[frames.length - 1].miner.logs.length, 5);
  // simulate the client dropping and coming back: it refetches /api/status
  res.req.emit("close");
  for (let i = 5; i < 8; i++) { state.miner.logs.push(`l${i}`, "info"); }
  state.dirty = true;
  hub.broadcast();
  await flush();
  const res2 = fakeRes();
  hub.handleConnection(res2.req, res2);
  const fresh = parseFrames(res2.written)[0];
  assert.equal(fresh.miner.logs.length, 8, "fresh client gets full replay");
  hub.closeAll();
});
