"use strict";

const { formatStatsSnapshot } = require("./state");
const { LIMITS } = require("./constants");
const { unrefTimer, unrefInterval } = require("./timers");

const HEARTBEAT_FRAME = ": hb\n\n";
const OPEN_FRAME = ": stream established\n\n";

class SseHub {
  constructor({ state, onSubscriberChange }) {
    this.state = state;
    this.onSubscriberChange = onSubscriberChange;
    this.clients = new Map();
    this.bcastTimer = null;
    this.heartbeatTimer = null;
    this.lastNotified = -1;
  }

  get size() {
    return this.clients.size;
  }

  _frame(snapshot) {
    return `event: stats\ndata: ${JSON.stringify(snapshot)}\n\n`;
  }

  _fullFrame() {
    return this._frame(formatStatsSnapshot(this.state));
  }

  _startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = unrefInterval(() => {
      for (const [res] of this.clients) {
        if (!this._write(res, HEARTBEAT_FRAME)) this._drop(res);
      }
    }, LIMITS.HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  _write(res, payload) {
    if (res.writableEnded || res.destroyed) return false;
    try {
      const drained = res.write(payload);
      if (!drained) {
        const meta = this.clients.get(res);
        if (meta) {
          meta.blocked = true;
          res.once("drain", () => {
            const current = this.clients.get(res);
            if (!current) return;
            current.blocked = false;
            current.blockedCount = 0;
          });
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  _drop(res) {
    if (!this.clients.delete(res)) return;
    try { res.end(); } catch { }
    if (this.clients.size === 0) this._stopHeartbeat();
    this._notifyChange();
  }

  _notifyChange() {
    const size = this.clients.size;
    if (size === this.lastNotified) return;
    this.lastNotified = size;
    if (typeof this.onSubscriberChange === "function") this.onSubscriberChange(size);
  }

  broadcast() {
    if (this.clients.size === 0 || !this.state.dirty || this.bcastTimer) return;
    this.bcastTimer = unrefTimer(() => {
      this.bcastTimer = null;
      if (this.clients.size === 0) return;
      const seq = this.state.miner.logs.seq;
      const frames = new Map();
      this.state.dirty = false;
      for (const [res, meta] of this.clients) {
        if (meta.blocked) {
          meta.blockedCount++;
          if (meta.blockedCount >= LIMITS.SSE_MAX_BLOCKED_TICKS) this._drop(res);
          continue;
        }
        let payload = frames.get(meta.lastLogSeq);
        if (payload === undefined) {
          payload = this._frame(formatStatsSnapshot(this.state, { logsSince: meta.lastLogSeq }));
          frames.set(meta.lastLogSeq, payload);
        }
        if (this._write(res, payload)) meta.lastLogSeq = seq;
        else this._drop(res);
      }
    }, LIMITS.BROADCAST_MS);
  }

  _reapDeadClients() {
    for (const [res] of this.clients) {
      const dead = res.writableEnded || res.destroyed || (res.socket && (res.socket.destroyed || !res.socket.writable));
      if (dead) this._drop(res);
    }
  }

  handleConnection(req, res) {
    if (this.clients.size >= LIMITS.MAX_SSE_CLIENTS) this._reapDeadClients();
    if (this.clients.size >= LIMITS.MAX_SSE_CLIENTS) {
      try { res.write("event: rejected\ndata: too_many_clients\n\n"); res.end(); } catch { }
      return false;
    }
    const meta = { lastLogSeq: 0, blocked: false, blockedCount: 0 };
    this.clients.set(res, meta);
    let frame;
    try { frame = this._fullFrame(); } catch { frame = this._frame({ now: Date.now(), error: "snapshot_failed" }); }
    if (!this._write(res, OPEN_FRAME) || !this._write(res, frame)) {
      this._drop(res);
      return false;
    }
    meta.lastLogSeq = this.state.miner.logs.seq;
    if (typeof res.flush === "function") res.flush();
    this.state.dirty = false;
    this._startHeartbeat();
    this._notifyChange();
    const cleanup = () => {
      if (!this.clients.has(res)) return;
      this.clients.delete(res);
      if (this.clients.size === 0) {
        this._stopHeartbeat();
        if (this.bcastTimer) { clearTimeout(this.bcastTimer); this.bcastTimer = null; }
      }
      this._notifyChange();
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
    return true;
  }

  closeAll() {
    if (this.bcastTimer) { clearTimeout(this.bcastTimer); this.bcastTimer = null; }
    this._stopHeartbeat();
    for (const [res] of this.clients) { try { res.end(); } catch { } }
    this.clients.clear();
    this._notifyChange();
  }
}

module.exports = { SseHub };
