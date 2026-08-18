"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { SseHub } = require("../../src/sse");
const { createState } = require("../../src/state");
const { LIMITS } = require("../../src/constants");
const { delay } = require("../helpers/harness");

/** Minimal ServerResponse stand-in with controllable backpressure. */
class FakeRes extends EventEmitter {
  constructor({ drains = true, throwOnWrite = false } = {}) {
    super();
    this.frames = [];
    this.writableEnded = false;
    this.destroyed = false;
    this.socket = { destroyed: false, writable: true };
    this._drains = drains;
    this._throw = throwOnWrite;
  }
  write(payload) {
    if (this._throw) throw new Error("EPIPE");
    if (this.writableEnded || this.destroyed) return false;
    this.frames.push(payload);
    return this._drains;
  }
  end() {
    this.writableEnded = true;
  }
  get snapshots() {
    return this.frames
      .filter(f => f.startsWith("event: stats"))
      .map(f => JSON.parse(f.slice(f.indexOf("data: ") + 6)));
  }
}

const fakeReq = () => new EventEmitter();

function hubWithState() {
  const state = createState("wallet", 5);
  const changes = [];
  const hub = new SseHub({ state, onSubscriberChange: n => changes.push(n) });
  return { state, hub, changes };
}

test("a new subscriber immediately receives the complete state", () => {
  const { state, hub } = hubWithState();
  state.miner.logs.push("first", "info");
  state.miner.logs.push("second", "info");

  const res = new FakeRes();
  assert.equal(hub.handleConnection(fakeReq(), res), true);

  const [snapshot] = res.snapshots;
  assert.equal(snapshot.miner.logs.length, 2);
  assert.equal(snapshot.logCount, 2);
  assert.ok(res.frames[0].startsWith(": stream established"));
});

test("subsequent frames only carry new console lines", async () => {
  const { state, hub } = hubWithState();
  const res = new FakeRes();
  hub.handleConnection(fakeReq(), res);

  state.miner.logs.push("line A", "info");
  state.dirty = true;
  hub.broadcast();
  await delay(LIMITS.BROADCAST_MS + 30);

  const latest = res.snapshots.at(-1);
  assert.equal(latest.miner.logs.length, 1, "delta only");
  assert.equal(latest.miner.logs[0].text, "line A");
  assert.equal(latest.logCount, 1);
});

test("the union of all frames reproduces the log exactly once", async () => {
  const { state, hub } = hubWithState();
  const res = new FakeRes();
  hub.handleConnection(fakeReq(), res);

  for (let i = 1; i <= 4; i++) {
    state.miner.logs.push(`entry ${i}`, "info");
    state.dirty = true;
    hub.broadcast();
    await delay(LIMITS.BROADCAST_MS + 20);
  }

  const ids = res.snapshots.flatMap(s => s.miner.logs.map(l => l.id));
  assert.deepEqual(ids, [1, 2, 3, 4]);
});

test("a client that missed frames is resynchronised, never left with a hole", async () => {
  const { state, hub } = hubWithState();
  const res = new FakeRes({ drains: false });
  hub.handleConnection(fakeReq(), res);

  // First write does not drain -> the client is marked blocked and skipped.
  state.miner.logs.push("missed 1", "info");
  state.dirty = true;
  hub.broadcast();
  await delay(LIMITS.BROADCAST_MS + 20);

  const before = res.snapshots.length;
  state.miner.logs.push("missed 2", "info");
  state.dirty = true;
  hub.broadcast();
  await delay(LIMITS.BROADCAST_MS + 20);
  assert.equal(res.snapshots.length, before, "blocked clients are skipped");

  // Socket drains: the next frame must include everything that was missed.
  res.emit("drain");
  state.miner.logs.push("after drain", "info");
  state.dirty = true;
  hub.broadcast();
  await delay(LIMITS.BROADCAST_MS + 20);

  const texts = res.snapshots.at(-1).miner.logs.map(l => l.text);
  assert.deepEqual(texts, ["missed 1", "missed 2", "after drain"]);
});

test("a permanently stalled client is dropped instead of buffering forever", async () => {
  const { state, hub } = hubWithState();
  const res = new FakeRes({ drains: false });
  hub.handleConnection(fakeReq(), res);

  for (let i = 0; i < LIMITS.SSE_MAX_BLOCKED_TICKS + 2; i++) {
    state.miner.logs.push(`spam ${i}`, "info");
    state.dirty = true;
    hub.broadcast();
    await delay(LIMITS.BROADCAST_MS + 15);
  }
  assert.equal(hub.size, 0, "stalled client removed");
  assert.equal(res.writableEnded, true);
});

test("write failures evict the client without throwing", () => {
  const { state, hub } = hubWithState();
  const res = new FakeRes({ throwOnWrite: true });
  assert.doesNotThrow(() => hub.handleConnection(fakeReq(), res));
  assert.equal(hub.size, 0);
  assert.equal(state.dirty, true);
});

test("the client cap is enforced and dead sockets are reaped first", () => {
  const { hub } = hubWithState();
  const clients = [];
  for (let i = 0; i < LIMITS.MAX_SSE_CLIENTS; i++) {
    const res = new FakeRes();
    assert.equal(hub.handleConnection(fakeReq(), res), true);
    clients.push(res);
  }

  const overflow = new FakeRes();
  assert.equal(hub.handleConnection(fakeReq(), overflow), false);
  assert.equal(hub.size, LIMITS.MAX_SSE_CLIENTS);
  assert.match(overflow.frames.join(""), /Too many clients/);

  // A dead socket must not permanently consume a slot.
  clients[0].destroyed = true;
  const replacement = new FakeRes();
  assert.equal(hub.handleConnection(fakeReq(), replacement), true);
  assert.equal(hub.size, LIMITS.MAX_SSE_CLIENTS);
});

test("subscriber transitions are reported exactly once each way", () => {
  const { hub, changes } = hubWithState();
  const a = new FakeRes();
  const b = new FakeRes();
  const reqA = fakeReq();
  const reqB = fakeReq();

  hub.handleConnection(reqA, a);
  hub.handleConnection(reqB, b);
  reqA.emit("close");
  reqA.emit("close"); // duplicate close events must be idempotent
  reqB.emit("close");

  assert.deepEqual(changes, [1, 2, 1, 0]);
  assert.equal(hub.size, 0);
});

test("one heartbeat timer serves every client and is released at zero", () => {
  const { hub } = hubWithState();
  const reqs = [];
  for (let i = 0; i < 3; i++) {
    const req = fakeReq();
    reqs.push(req);
    hub.handleConnection(req, new FakeRes());
  }
  assert.ok(hub.heartbeatTimer, "heartbeat armed");

  for (const req of reqs) req.emit("close");
  assert.equal(hub.heartbeatTimer, null, "heartbeat released");
});

test("broadcasting is coalesced and skipped when nothing changed", async () => {
  const { state, hub } = hubWithState();
  const res = new FakeRes();
  hub.handleConnection(fakeReq(), res);
  const baseline = res.snapshots.length;

  state.miner.logs.push("x", "info");
  state.dirty = true;
  for (let i = 0; i < 50; i++) hub.broadcast();
  await delay(LIMITS.BROADCAST_MS + 30);
  assert.equal(res.snapshots.length, baseline + 1, "50 calls collapse into one frame");

  for (let i = 0; i < 10; i++) hub.broadcast();
  await delay(LIMITS.BROADCAST_MS + 30);
  assert.equal(res.snapshots.length, baseline + 1, "clean state produces no frames");
});

test("no work is performed when nobody is subscribed", async () => {
  const { state, hub } = hubWithState();
  state.dirty = true;
  hub.broadcast();
  assert.equal(hub.bcastTimer, null);
  await delay(30);
  assert.equal(hub.size, 0);
});

test("closeAll ends every stream and clears all timers", () => {
  const { state, hub } = hubWithState();
  const responses = [new FakeRes(), new FakeRes()];
  for (const res of responses) hub.handleConnection(fakeReq(), res);
  state.dirty = true;
  hub.broadcast();

  hub.closeAll();
  assert.equal(hub.size, 0);
  assert.equal(hub.bcastTimer, null);
  assert.equal(hub.heartbeatTimer, null);
  for (const res of responses) assert.equal(res.writableEnded, true);
});
