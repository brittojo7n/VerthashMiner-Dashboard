const config = require("./src/config");
const { createState } = require("./src/state");
const { GpuManager } = require("./src/gpu");
const { SseHub } = require("./src/sse");
const { MinerManager } = require("./src/miner");
const { createHttpServer, getLanIp } = require("./src/http");

class Server {
  constructor() {
    this.config = config;
    this.state = createState(this.config.WALLET, this.config.MAX_LOGS);
    this._exiting = false;

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
      sseHub: this.sseHub,
      minerManager: this.minerManager
    });

    this.boundExit = this.stop.bind(this);
  }

  start() {
    this._attachSignalHandlers();

    this.httpServer.listen(this.config.PORT, this.config.HOST, () => {
      console.log(
        `[dashboard] http://${this.config.HOST}:${this.config.PORT}\n[dashboard] LAN: http://${getLanIp()}:${this.config.PORT}`
      );
    });

    this.minerManager.start();
  }

  stop() {
    if (this._exiting) return;
    this._exiting = true;

    this._detachSignalHandlers();
    this.gpuManager.stop();
    this.sseHub.closeAll();

    const closeHttpServer = () => new Promise(resolve => {
      if (!this.httpServer.listening) return resolve();
      this.httpServer.close(resolve);
    });

    this.minerManager.stop()
      .then(() => closeHttpServer())
      .catch(() => closeHttpServer())
      .finally(() => process.exit(0));
  }

  _attachSignalHandlers() {
    process.on("SIGINT", this.boundExit);
    process.on("SIGTERM", this.boundExit);
  }

  _detachSignalHandlers() {
    process.removeListener("SIGINT", this.boundExit);
    process.removeListener("SIGTERM", this.boundExit);
  }
}

new Server().start();
