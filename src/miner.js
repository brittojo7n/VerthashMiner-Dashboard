const { spawn } = require("node:child_process");
const { parseMinerLine } = require("./parser");

function createStreamReader(onLine, onFlush) {
  let buffer = "";
  return function handleChunk(chunk) {
    buffer += String(chunk);
    const lastNewlineIdx = buffer.lastIndexOf("\n");
    if (lastNewlineIdx !== -1) {
      const lines = buffer.slice(0, lastNewlineIdx).split(/\r?\n/);
      for (const line of lines) {
        if (line) onLine(line + "\n");
      }
      buffer = buffer.slice(lastNewlineIdx + 1);
      if (typeof onFlush === "function") onFlush();
    }
  };
}

class MinerManager {
  constructor({ config, state, onUpdate }) {
    this.config = config;
    this.state = state;
    this.onUpdate = onUpdate;
    this.proc = null;
    this._stopPromise = null;
    this._stopResolve = null;
    this._forceKillTimer = null;
  }

  pushLog(text, type = "info") {
    if (this.state?.miner?.logs) {
      this.state.miner.logs.push(text, type);
      this.state.miner.lastLine = text;
    }
  }

  start() {
    if (this.state.miner.running || this._stopPromise || this.state.mining.status === "STARTING") {
      return;
    }

    this._resetMiningStats();

    const { MINER_EXE, MINER_ARGS, MINER_CWD } = this.config;

    if (!MINER_CWD || !MINER_ARGS.length) {
      const msg = !MINER_CWD
        ? "MINER_CWD not configured in .env"
        : "MINER_ARGS not configured in .env";
      this.state.miner.lastError = msg;
      this.state.mining.status = "STOPPED";
      this.pushLog(msg, "warn");
      return;
    }

    this.state.mining.status = "STARTING";
    if (typeof this.onUpdate === "function") this.onUpdate();

    this.pushLog("Starting miner...", "warn");
    this.pushLog("Building PCI to CUDA device map...", "info");

    try {
      const listProc = spawn(MINER_EXE, ["--device-list"], {
        cwd: MINER_CWD,
        windowsHide: true,
        shell: false,
        detached: false
      });

      let buf = "";
      listProc.stdout.on("data", c => buf += String(c));
      listProc.stderr.on("data", c => buf += String(c));

      listProc.on("close", () => {
        let inCuda = false;
        for (const line of buf.split("\n")) {
          if (line.includes("CUDA devices:")) { inCuda = true; continue; }
          if (line.includes("OpenCL devices:")) { inCuda = false; continue; }
          if (inCuda) {
            const match = line.match(/Index:\s*(\d+).*?pcieId:\s*([0-9a-fA-F:.]+)/i);
            if (match) {
              const id = match[1];
              let pci = match[2];
              const m = pci.match(/([0-9a-fA-F]{2}):([0-9a-fA-F]{2})\.?([0-9a-fA-F]?)/i);
              if (m) pci = `${m[1].toLowerCase()}:${m[2].toLowerCase()}:${(m[3]||"0").toLowerCase()}`;
              this.state.mining.pciMap[pci] = id;
            }
          }
        }
        this._startMiner();
      });

      listProc.on("error", () => this._startMiner());
    } catch {
      this._startMiner();
    }
  }

  _resetMiningStats() {
    this.state.mining.hashrateKHs = null;
    this.state.mining.accepted = 0;
    this.state.mining.submitted = 0;
    this.state.mining.rejected = 0;
    this.state.mining.difficulty = null;
    this.state.mining.lastAcceptedAt = null;
    this.state.mining.gpuHashrates = {};
    this.state.mining.hashratesReady = false;
  }

  _startMiner() {
    const { MINER_EXE, MINER_ARGS, MINER_CWD } = this.config;
    this.pushLog(`Starting: ${MINER_EXE} ${MINER_ARGS.join(" ")}`, "info");

    try {
      this.proc = spawn(MINER_EXE, MINER_ARGS, {
        cwd: MINER_CWD,
        windowsHide: false,
        shell: false,
        detached: false,
        stdio: ["inherit", "pipe", "pipe"]
      });
    } catch (err) {
      this.state.miner.running = false;
      this.state.miner.lastError = err.message;
      this.state.mining.status = "CRASHED";
      this.pushLog(err.message, "error");
      if (typeof this.onUpdate === "function") this.onUpdate();
      return;
    }

    this.state.miner.running = true;
    this.state.mining.status = "STARTING";

    const handleLine = line =>
      parseMinerLine(line, this.state, (l, t) => this.pushLog(l, t));
    const handleFlush = () => {
      if (typeof this.onUpdate === "function") this.onUpdate();
    };

    this.proc.stdout.on("data", createStreamReader(handleLine, handleFlush));
    this.proc.stderr.on("data", createStreamReader(handleLine, handleFlush));

    this.proc.on("error", err => {
      this.state.miner.running = false;
      this.state.miner.lastError = err.message;
      this.state.mining.status = "CRASHED";
      this._resetMiningStats();
      this.pushLog(err.message, "error");
      this._settle();
      if (typeof this.onUpdate === "function") this.onUpdate();
    });

    this.proc.on("close", (code, sig) => {
      this.state.miner.running = false;
      this.state.miner.exitCode = code;
      this.state.mining.status = (code === 0 || code === null) ? "STOPPED" : "CRASHED";
      this._resetMiningStats();
      this.pushLog(
        `Exited (code: ${code}${sig ? `, sig: ${sig}` : ""})`,
        code === 0 ? "info" : "warn"
      );
      this.proc = null;
      this._settle();
      if (typeof this.onUpdate === "function") this.onUpdate();
    });
  }

  stop() {
    if (!this.proc || !this.state.miner.running) {
      return Promise.resolve();
    }

    if (this._stopPromise) {
      return this._stopPromise;
    }

    this.state.mining.status = "STOPPING";
    this.pushLog("Sending terminate signal to miner...", "warn");
    if (typeof this.onUpdate === "function") this.onUpdate();

    this._stopPromise = new Promise(resolve => {
      this._stopResolve = resolve;

      try { this.proc.kill("SIGTERM"); } catch { }

      this._forceKillTimer = setTimeout(() => {
        if (this.proc && !this.proc.killed) {
          try { this.proc.kill("SIGKILL"); } catch { }
        }
        this._settle();
      }, 10000);
      this._forceKillTimer.unref();
    });

    return this._stopPromise;
  }

  _settle() {
    if (this._forceKillTimer) {
      clearTimeout(this._forceKillTimer);
      this._forceKillTimer = null;
    }
    if (this._stopResolve) {
      this._stopResolve();
      this._stopResolve = null;
    }
    this._stopPromise = null;
  }

  restart() {
    if (this._stopPromise) return this._stopPromise.then(() => this.start());
    if (this.state.miner.running) {
      return this.stop().then(() => this.start());
    }
    this.start();
    return Promise.resolve();
  }
}

module.exports = {
  MinerManager
};
