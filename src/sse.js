const { formatStatsSnapshot } = require("./state");

class SseHub {
  constructor({ state, onSubscriberChange }) {
    this.state = state;
    this.onSubscriberChange = onSubscriberChange;
    this.clients = new Set();
    this.bcastTimer = null;
    this.syncTimer = setInterval(() => this.broadcast(), 2000);
    this.syncTimer.unref();
  }

  get size() {
    return this.clients.size;
  }

  broadcast() {
    if (this.clients.size === 0 || this.bcastTimer !== null) return;

    this.bcastTimer = setImmediate(() => {
      this.bcastTimer = null;
      if (this.clients.size === 0) return;

      const payload = `event: stats\ndata: ${JSON.stringify(formatStatsSnapshot(this.state))}\n\n`;

      for (const res of this.clients) {
        try {
          res.write(payload);
        } catch {
          this.clients.delete(res);
          this._notifyChange();
        }
      }
    });
  }

  handleConnection(req, res) {
    this.clients.add(res);
    this._notifyChange();
    this.broadcast();

    const heartbeat = setInterval(() => {
      try {
        res.write(": hb\n\n");
      } catch {
        clearInterval(heartbeat);
        this.clients.delete(res);
        this._notifyChange();
      }
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      if (this.clients.has(res)) {
        this.clients.delete(res);
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
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
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
