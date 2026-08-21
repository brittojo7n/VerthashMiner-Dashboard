"use strict";

const config = require("./server/core/config");
const { createState } = require("./server/core/state");
const { GpuManager } = require("./server/miner/gpu");
const { SseHub } = require("./server/http/sse");
const { MinerManager } = require("./server/miner/miner");
const os = require("node:os");
const crypto = require("node:crypto");
const { createHttpServer, getLanIp } = require("./server/http/http");
const { LIMITS, LOG } = require("./server/core/constants");
const { unrefTimer } = require("./server/core/timers");

function yieldCpuToMiner() {
  if (process.platform !== "win32") return false;
  try {
    os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    return true;
  } catch {
    return false;
  }
}

class Server {
  constructor(options = {}) {
    this.config = options.config || config;
    this.state = createState(this.config.WALLET, LIMITS.MAX_LOGS);
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
      webDir: options.webDir
    });

    this.boundExit = () => this.stop();
    this.handleSigint = () => {
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
    }
  }

  start() {
    this._attachSignalHandlers();
    if (yieldCpuToMiner()) console.log("[dashboard] running at below-normal priority");

    this._listening = false;

    this.httpServer.on("error", err => {
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

  stop(exitCode = 0) {
    if (this._exiting) return;
    this._exiting = true;

    this._detachSignalHandlers();
    this.gpuManager.stop();
    this.sseHub.closeAll();

    this._shutdownWatchdog = unrefTimer(() => {
      console.error("[dashboard] shutdown watchdog fired; forcing exit.");
      process.exit(exitCode);
    }, LIMITS.SHUTDOWN_TIMEOUT_MS);

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

function generateSecret() {
  const secret = crypto.randomBytes(32).toString("hex");
  console.log(secret);
  console.log(`\n[+] ${secret.length}-character cryptographic secret generated.`);
  console.log("    Paste this into your .env as SESSION_SECRET=<value>");
}

if (require.main === module) {
  if (process.argv.includes("--generate-secret") || process.argv.includes("--gen-secret")) {
    generateSecret();
    process.exit(0);
  }
  main();
}

module.exports = { Server, main, yieldCpuToMiner };
