const config = require("./config");
const { createState } = require("./state");
const { GpuManager } = require("./gpu");
const { SseHub } = require("./sse");
const { MinerManager } = require("./miner");
const { createHttpServer, getLanIp } = require("./http");

class App {
  constructor() {
    this.config = config;
    this.state = createState(this.config.WALLET, this.config.MAX_LOGS);

    this.gpuManager = null;
    this.sseHub = new SseHub({
      state: this.state,
      onSubscriberChange: count => {
        if (this.gpuManager) this.gpuManager.updateSubscribers(count);
      }
    });

    this.gpuManager = new GpuManager({
      state: this.state,
      pollMs: this.config.GPU_POLL_MS,
      onUpdate: () => this.sseHub.broadcast()
    });

    this.minerManager = new MinerManager({
      config: this.config,
      state: this.state,
      onUpdate: () => this.sseHub.broadcast()
    });

    this.httpServer = createHttpServer({
      config: this.config,
      state: this.state,
      sseHub: this.sseHub
    });

    this.boundExit = this.stop.bind(this);
  }

  start() {
    this._attachSignalHandlers();

    this.httpServer.listen(this.config.PORT, this.config.HOST, () => {
      const lan = getLanIp();
      console.log(`[dashboard] http://${this.config.HOST}:${this.config.PORT}\n[dashboard] LAN: http://${lan}:${this.config.PORT}`);
    });

    this.minerManager.start();
  }

  stop() {
    this._detachSignalHandlers();

    if (this.gpuManager) this.gpuManager.stop();
    if (this.sseHub) this.sseHub.closeAll();
    if (this.minerManager) this.minerManager.stop();

    if (this.httpServer && this.httpServer.listening) {
      this.httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    } else {
      process.exit(0);
    }
  }

  _attachSignalHandlers() {
    process.once("SIGINT", this.boundExit);
    process.once("SIGTERM", this.boundExit);
  }

  _detachSignalHandlers() {
    process.removeListener("SIGINT", this.boundExit);
    process.removeListener("SIGTERM", this.boundExit);
  }
}

module.exports = App
