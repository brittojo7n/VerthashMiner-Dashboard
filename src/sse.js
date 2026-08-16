"use strict";

const { formatStatsSnapshot } = require("./state");
const { LIMITS } = require("./constants");

class SseHub {
  constructor({ state, onSubscriberChange }) {
    this.state = state;
    this.onSubscriberChange = onSubscriberChange;
    this.clients = new Set();
    this.bcastTimer = null;
    this.cachedPayload = null;
  }

  get size() {
    return this.clients.size;
  }

  broadcast() {
    if (this.clients.size === 0 || !this.state.dirty) return;

    if (this.bcastTimer) return;

    this.bcastTimer = setTimeout(() => {
      this.bcastTimer = null;
      if (this.clients.size === 0) return;
      if (this.state.dirty || !this.cachedPayload) {
        this.cachedPayload = `event: stats\ndata: ${JSON.stringify(formatStatsSnapshot(this.state))}\n\n`;
        this.state.dirty = false;
      }

      const payload = this.cachedPayload;

      for (const res of this.clients) {
        if (res.blocked) {
          res.blockedCount = (res.blockedCount || 0) + 1;
          if (res.blockedCount >= 5) {
            this.clients.delete(res);
            this._notifyChange();
            res.end();
          }
          continue;
        }

        try {
          const drained = res.write(payload);
          if (!drained) {
            res.blocked = true;
            res.once("drain", () => {
              res.blocked = false;
              res.blockedCount = 0;
            });
          }
        } catch {
          this.clients.delete(res);
          this._notifyChange();
        }
      }
    }, LIMITS.BROADCAST_MS);
  }

  _reapDeadClients() {
    for (const res of this.clients) {
      const dead = res.writableEnded || res.destroyed ||
        (res.socket && (res.socket.destroyed || !res.socket.writable));
      if (dead) {
        this.clients.delete(res);
        try { res.end(); } catch { }
      }
    }
  }

  handleConnection(req, res) {
    if (this.clients.size >= LIMITS.MAX_SSE_CLIENTS) {
      this._reapDeadClients();
      this._notifyChange();
    }
    if (this.clients.size >= LIMITS.MAX_SSE_CLIENTS) {
      res.write("event: error\ndata: Too many clients\n\n");
      res.end();
      return;
    }

    this.clients.add(res);
    this._notifyChange();

    try {
      res.write(": stream established\n\n");

      let freshSnapshot;
      try {
        freshSnapshot = formatStatsSnapshot(this.state);
        this.state.dirty = false;
      } catch {
        freshSnapshot = { now: Date.now(), miner: this.state.miner, mining: this.state.mining, gpu: this.state.gpu, host: this.state.host };
      }
      this.cachedPayload = `event: stats\ndata: ${JSON.stringify(freshSnapshot)}\n\n`;

      res.write(this.cachedPayload);

      if (res.flush) res.flush();
    } catch {
      this.clients.delete(res);
      this._notifyChange();
      return;
    }

    const heartbeat = setInterval(() => {
      try {
        res.write(": hb\n\n");
      } catch {
        clearInterval(heartbeat);
        this.clients.delete(res);
        this._notifyChange();
      }
    }, LIMITS.HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(heartbeat);
      if (this.clients.has(res)) {
        this.clients.delete(res);
        if (this.clients.size === 0 && this.bcastTimer) {
          clearTimeout(this.bcastTimer);
          this.bcastTimer = null;
        }
        this._notifyChange();
      }
    };

    req.on("close", cleanup);
    req.on("error", cleanup);
  }

  _notifyChange() {
    if (typeof this.onSubscriberChange === "function") {
      this.onSubscriberChange(this.clients.size);
    }
  }

  closeAll() {
    if (this.bcastTimer) {
      clearTimeout(this.bcastTimer);
      this.bcastTimer = null;
    }
    for (const res of this.clients) {
      try {
        res.end();
      } catch { }
    }
    this.clients.clear();
    this._notifyChange();
  }
}

module.exports = { SseHub };
