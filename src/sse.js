"use strict";

const { formatStatsSnapshot } = require("./state");
const { LIMITS } = require("./constants");

const HEARTBEAT_FRAME = ": hb\n\n";
const OPEN_FRAME = ": stream established\n\n";

/**
 * Server-Sent Events fan-out.
 *
 * Design notes
 *  - One shared heartbeat timer for every subscriber (not one per client), so
 *    a leaked connection can never leave a stray interval behind.
 *  - Stat frames are coalesced into a single serialisation per window and the
 *    resulting string is shared by all clients.
 *  - Console lines are delivered incrementally. Any client that missed a frame
 *    (backpressure, fresh connection) transparently receives a full snapshot
 *    instead of a delta, so the browser can never end up with a hole in the
 *    console.
 */
class SseHub {
  constructor({ state, onSubscriberChange }) {
    this.state = state;
    this.onSubscriberChange = onSubscriberChange;
    /** @type {Map<import('node:http').ServerResponse, {lastLogSeq:number, blocked:boolean, blockedCount:number}>} */
    this.clients = new Map();
    this.bcastTimer = null;
    this.heartbeatTimer = null;
    this.lastNotified = -1;
  }

  get size() {
    return this.clients.size;
  }

  /* ------------------------------------------------------------- internals */

  _frame(snapshot) {
    return `event: stats\ndata: ${JSON.stringify(snapshot)}\n\n`;
  }

  _fullFrame() {
    return this._frame(formatStatsSnapshot(this.state));
  }

  _startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const [res] of this.clients) {
        if (!this._write(res, HEARTBEAT_FRAME)) this._drop(res);
      }
    }, LIMITS.HEARTBEAT_MS);
    if (typeof this.heartbeatTimer.unref === "function") this.heartbeatTimer.unref();
  }

  _stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** @returns {boolean} false when the socket is gone. */
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
    try {
      res.end();
    } catch {
      /* socket already torn down */
    }
    if (this.clients.size === 0) this._stopHeartbeat();
    this._notifyChange();
  }

  _notifyChange() {
    const size = this.clients.size;
    if (size === this.lastNotified) return;
    this.lastNotified = size;
    if (typeof this.onSubscriberChange === "function") this.onSubscriberChange(size);
  }

  /* -------------------------------------------------------------- fan-out */

  broadcast() {
    if (this.clients.size === 0 || !this.state.dirty || this.bcastTimer) return;

    this.bcastTimer = setTimeout(() => {
      this.bcastTimer = null;
      if (this.clients.size === 0) return;

      const seq = this.state.miner.logs.seq;
      /** @type {Map<number,string>} lastLogSeq -> serialised frame (≤ 4 entries) */
      const frames = new Map();

      this.state.dirty = false;

      for (const [res, meta] of this.clients) {
        if (meta.blocked) {
          meta.blockedCount++;
          if (meta.blockedCount >= LIMITS.SSE_MAX_BLOCKED_TICKS) this._drop(res);
          continue;
        }

        // `since()` returns the whole retained buffer when a client has fallen
        // behind the retention window, so a delta can never leave a hole.
        let payload = frames.get(meta.lastLogSeq);
        if (payload === undefined) {
          payload = this._frame(formatStatsSnapshot(this.state, { logsSince: meta.lastLogSeq }));
          frames.set(meta.lastLogSeq, payload);
        }

        if (this._write(res, payload)) meta.lastLogSeq = seq;
        else this._drop(res);
      }
    }, LIMITS.BROADCAST_MS);

    if (typeof this.bcastTimer.unref === "function") this.bcastTimer.unref();
  }

  _reapDeadClients() {
    for (const [res] of this.clients) {
      const dead =
        res.writableEnded ||
        res.destroyed ||
        (res.socket && (res.socket.destroyed || !res.socket.writable));
      if (dead) this._drop(res);
    }
  }

  /**
   * Adopts an already-headed SSE response.
   * @returns {boolean} false when the connection was refused (client cap).
   */
  handleConnection(req, res) {
    if (this.clients.size >= LIMITS.MAX_SSE_CLIENTS) this._reapDeadClients();

    if (this.clients.size >= LIMITS.MAX_SSE_CLIENTS) {
      try {
        res.write("event: error\ndata: Too many clients\n\n");
        res.end();
      } catch {
        /* nothing to do */
      }
      return false;
    }

    const meta = { lastLogSeq: 0, blocked: false, blockedCount: 0 };
    this.clients.set(res, meta);

    let frame;
    try {
      frame = this._fullFrame();
    } catch {
      frame = this._frame({ now: Date.now(), error: "snapshot_failed" });
    }

    if (!this._write(res, OPEN_FRAME) || !this._write(res, frame)) {
      this._drop(res);
      return false;
    }
    meta.lastLogSeq = this.state.miner.logs.seq;
    if (typeof res.flush === "function") res.flush();

    this._startHeartbeat();
    this._notifyChange();

    const cleanup = () => {
      if (!this.clients.has(res)) return;
      this.clients.delete(res);
      if (this.clients.size === 0) {
        this._stopHeartbeat();
        if (this.bcastTimer) {
          clearTimeout(this.bcastTimer);
          this.bcastTimer = null;
        }
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
    if (this.bcastTimer) {
      clearTimeout(this.bcastTimer);
      this.bcastTimer = null;
    }
    this._stopHeartbeat();
    for (const [res] of this.clients) {
      try {
        res.end();
      } catch {
        /* socket already torn down */
      }
    }
    this.clients.clear();
    this._notifyChange();
  }
}

module.exports = { SseHub };
