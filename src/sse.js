const { formatStatsSnapshot } = require("./state");

class SseHub {
  constructor({ state, onSubscriberChange }) {
    this.state = state;
    this.onSubscriberChange = onSubscriberChange;
    this.clients = new Set();
    this.bcastTimer = null;
  }

  get size() {
    return this.clients.size;
  }

  broadcast() {
    if (this.clients.size === 0 || !this.state.dirty) return;

    if (this.bcastTimer) clearTimeout(this.bcastTimer);

    this.bcastTimer = setTimeout(() => {
      this.bcastTimer = null;
      if (this.clients.size === 0) return;
      this.state.dirty = false;

      const payload = `event: stats\ndata: ${JSON.stringify(formatStatsSnapshot(this.state))}\n\n`;

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
    }, 50);
  }

  handleConnection(req, res) {
    if (this.clients.size >= 4) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Too many clients");
      return;
    }

    this.clients.add(res);
    this._notifyChange();

    try {
      const payload = `event: stats\ndata: ${JSON.stringify(formatStatsSnapshot(this.state))}\n\n`;
      res.write(payload);
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
    }, 15000);

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
