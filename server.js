"use strict";

const config = require("./src/config");
const { createState } = require("./src/state");
const { GpuManager } = require("./src/gpu");
const { SseHub } = require("./src/sse");
const { MinerManager } = require("./src/miner");
const { createHttpServer, getLanIp } = require("./src/http");
const { LIMITS, LOG } = require("./src/constants");

/**
 * Wires the modules together and owns process lifecycle.
 *
 * Failsafe policy: the dashboard is a *supervisor*. It must never take the
 * miner down because of its own bug, and it must always be able to exit, so
 * every asynchronous shutdown step is bounded by a watchdog and every
 * unexpected throw is contained rather than fatal.
 */
class Server {
  constructor(options = {}) {
    this.config = options.config || config;
    this.state = createState(this.config.WALLET, this.config.MAX_LOGS);
    this._exiting = false;
    this._shutdownWatchdog = null;

    this.sseHub = new SseHub({
      state: this.state,
      onSubscriberChange: count => this._onSubscriberChange(count)
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
      minerManager: this.minerManager,
      publicDir: options.publicDir
    });

    this.boundExit = () => this.stop();
    this.handleSigint = () => {
      // Ctrl+C in a shared console also reaches the child; if we are already
      // stopping it, let that sequence finish instead of racing it.
      if (this.minerManager && this.minerManager.isStoppingChild) return;
      this.boundExit();
    };
    this.handleFault = (scope, err) => this._onFault(scope, err);
  }

  _onSubscriberChange(count) {
    if (count > 0) {
      this.gpuManager.updateSubscribers(count);
      this.minerManager.enableParsing();
    } else {
      this.gpuManager.updateSubscribers(0);
      this.minerManager.disableParsing();
    }
  }

  /**
   * Contained fault handler: log it, surface it in the UI console, keep the
   * miner running. Crashing here would leave an unsupervised child process.
   */
  _onFault(scope, err) {
    const message = `[dashboard] ${scope}: ${(err && err.stack) || err}`;
    try {
      console.error(message);
      this.minerManager.pushLog(
        `Dashboard internal error (${scope}): ${(err && err.message) || err}`,
        LOG.ERROR
      );
      this.sseHub.broadcast();
    } catch {
      /* last resort: never throw from the fault handler */
    }
  }

  start() {
    this._attachSignalHandlers();

    this._listening = false;

    this.httpServer.on("error", err => {
      // A failure to bind means there is no dashboard at all: fail loudly
      // instead of lingering as an invisible process.
      if (!this._listening) {
        if (err && err.code === "EADDRINUSE") {
          console.error(
            `[FATAL] Port ${this.config.PORT} is already in use. ` +
              "Another dashboard instance is probably running."
          );
        } else {
          console.error(
            `[FATAL] Could not bind ${this.config.HOST}:${this.config.PORT} - ${err && err.message}`
          );
        }
        process.exit(1);
      }
      this._onFault("http", err);
    });

    this.httpServer.listen(this.config.PORT, this.config.HOST, () => {
      this._listening = true;
      const port = this.httpServer.address().port;
      console.log(
        `[dashboard] http://${this.config.HOST}:${port}\n` +
          `[dashboard] LAN: http://${getLanIp()}:${port}`
      );
    });

    this.minerManager.start();
    return this;
  }

  /** Graceful shutdown with a hard ceiling. */
  stop(exitCode = 0) {
    if (this._exiting) return;
    this._exiting = true;

    this._detachSignalHandlers();
    this.gpuManager.stop();
    this.sseHub.closeAll();

    // Never hang: if the miner or a socket refuses to close, leave anyway.
    this._shutdownWatchdog = setTimeout(() => {
      console.error("[dashboard] shutdown watchdog fired; forcing exit.");
      process.exit(exitCode);
    }, LIMITS.SHUTDOWN_TIMEOUT_MS);
    if (typeof this._shutdownWatchdog.unref === "function") this._shutdownWatchdog.unref();

    const closeHttpServer = () =>
      new Promise(resolve => {
        if (!this.httpServer.listening) return resolve();
        if (typeof this.httpServer.closeAllConnections === "function") {
          this.httpServer.closeAllConnections();
        }
        this.httpServer.close(() => resolve());
      });

    Promise.resolve()
      .then(() => this.minerManager.stop())
      .catch(err => this._onFault("miner-stop", err))
      .then(() => {
        this.minerManager.dispose();
        return closeHttpServer();
      })
      .catch(err => this._onFault("http-close", err))
      .then(() => {
        clearTimeout(this._shutdownWatchdog);
        process.exit(exitCode);
      });
  }

  _attachSignalHandlers() {
    this._onUncaught = err => this.handleFault("uncaughtException", err);
    this._onRejection = err => this.handleFault("unhandledRejection", err);

    process.on("SIGINT", this.handleSigint);
    process.on("SIGTERM", this.boundExit);
    process.on("uncaughtException", this._onUncaught);
    process.on("unhandledRejection", this._onRejection);
  }

  _detachSignalHandlers() {
    process.removeListener("SIGINT", this.handleSigint);
    process.removeListener("SIGTERM", this.boundExit);
    if (this._onUncaught) process.removeListener("uncaughtException", this._onUncaught);
    if (this._onRejection) process.removeListener("unhandledRejection", this._onRejection);
  }
}

function main() {
  const fatal = config.validateConfig(config);
  if (fatal.length) {
    for (const problem of fatal) console.error(`[FATAL] ${problem}`);
    console.error("[FATAL] The dashboard will now shut down.");
    process.exit(1);
  }
  for (const note of config.advisories(config)) console.warn(`[dashboard] ${note}`);

  new Server().start();
}

if (require.main === module) main();

module.exports = { Server, main };
