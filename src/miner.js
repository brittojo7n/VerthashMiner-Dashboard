const { spawn, execFile } = require("node:child_process");
const { parseMinerLine } = require("./parser");

const RX_NORM = /\x1b\[[0-?]*[ -/]*[@-~]/g;

const FORWARD_CONSOLE = process.env.FORWARD_MINER_CONSOLE === "true";

function createStreamReader(onLine, onFlush, isEnabled, isStderr) {
  let buffer = "";
  return function handleChunk(chunk) {
    if (FORWARD_CONSOLE) {
      if (isStderr) {
        process.stderr.write(chunk);
      } else {
        process.stdout.write(chunk);
      }
    }
    buffer += chunk;
    if (buffer.length > 65536) {
      const lastNl = buffer.lastIndexOf("\n");
      buffer = lastNl !== -1 ? buffer.slice(lastNl + 1) : "";
    }
    const lastNewlineIdx = buffer.lastIndexOf("\n");
    if (lastNewlineIdx !== -1) {
      const lines = buffer.slice(0, lastNewlineIdx).split(/\r?\n/);
      const enabled = isEnabled();
      for (const line of lines) {
        if (line) onLine(line, enabled);
      }
      buffer = buffer.slice(lastNewlineIdx + 1);
      if (enabled && typeof onFlush === "function") onFlush();
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
    this.parsingEnabled = false;
    this.isStoppingChild = false;
    this.history = [];
  }

  enableParsing() {
    if (!this.parsingEnabled) {
      this.parsingEnabled = true;
      for (const line of this.history) {
        parseMinerLine(line, this.state, () => {});
      }
    }
  }

  disableParsing() {
    this.parsingEnabled = false;
  }

  pushLog(text, type = "info") {
    if (this.state?.miner?.logs) {
      this.state.miner.logs.push(text, type);
      this.state.miner.lastLine = text;
      this.state.dirty = true;
    }
  }

  start() {
    if (this._stopPromise) {
      return this._stopPromise.then(() => this.start());
    }

    if (this.state.miner.running || this.state.mining.status === "STARTING") {
      return Promise.resolve();
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
      return Promise.resolve();
    }

    this.state.mining.status = "STARTING";
    this.pushLog("Starting miner...", "system");
    if (typeof this.onUpdate === "function" && this.parsingEnabled) this.onUpdate();

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
              if (m) pci = `${m[1].toLowerCase()}:${m[2].toLowerCase()}:${(m[3] || "0").toLowerCase()}`;
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

    return Promise.resolve();
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
      if (typeof this.onUpdate === "function" && this.parsingEnabled) this.onUpdate();
      return;
    }

    this.state.miner.running = true;
    this.state.miner.pid = this.proc.pid;
    this.state.miner.startedAt = Date.now();
    this.state.mining.status = "STARTING";
    if (typeof this.onUpdate === "function" && this.parsingEnabled) this.onUpdate();

    const handleLine = (line, enabled) => {
      if (enabled) {
        parseMinerLine(line, this.state, (l, t) => this.pushLog(l, t));
      } else {
        this.history.push(line);
        if (this.history.length > 25) this.history.shift();
        const clean = String(line).replace(RX_NORM, "").trim();
        if (clean) {
          this.pushLog(clean, "info");
        }
      }
    };

    const handleFlush = () => {
      if (typeof this.onUpdate === "function" && this.parsingEnabled) this.onUpdate();
    };

    this.proc.stdout.on("data", createStreamReader(handleLine, handleFlush, () => this.parsingEnabled, false));
    this.proc.stderr.on("data", createStreamReader(handleLine, handleFlush, () => this.parsingEnabled, true));

    this.proc.on("error", err => {
      this.isStoppingChild = false;
      this.state.miner.running = false;
      this.state.miner.lastError = err.message;
      this.state.mining.status = "CRASHED";
      this._resetMiningStats();
      this.pushLog(err.message, "error");
      if (typeof this.onUpdate === "function" && this.parsingEnabled) this.onUpdate();
    });

    this.proc.on("close", (code, sig) => {
      this.isStoppingChild = false;
      this.state.miner.running = false;
      this.state.miner.exitCode = code;
      this.state.miner.signal = sig;
      if (this.state.mining.status !== "STOPPING" && this.state.mining.status !== "STOPPED") {
        this.state.mining.status = (code === 0 || code === null) ? "STOPPED" : "CRASHED";
      }
      this._resetMiningStats();
      this.pushLog(
        `Exited (code: ${code}${sig ? `, sig: ${sig}` : ""})`,
        "system"
      );
      this.proc = null;
      if (typeof this.onUpdate === "function" && this.parsingEnabled) this.onUpdate();
    });
  }

  stop() {
    if (!this.proc || !this.state.miner.running) return Promise.resolve();
    if (this._stopPromise) return this._stopPromise;

    this.state.mining.status = "STOPPING";
    if (typeof this.onUpdate === "function" && this.parsingEnabled) this.onUpdate();

    const pid = this.proc.pid;
    this.isStoppingChild = true;

    this._stopPromise = new Promise(resolve => {
      const onExit = () => {
        if (this._forceKillTimer) {
          clearTimeout(this._forceKillTimer);
          this._forceKillTimer = null;
        }
        this.proc = null;
        this.state.mining.status = "STOPPED";
        resolve();
        this._stopPromise = null;
        this.isStoppingChild = false;
      };

      this.proc.once("close", onExit);
      this.proc.once("exit", onExit);

      if (process.platform === "win32") {
        execFile("taskkill.exe", ["/pid", String(pid), "/T", "/F"]);
      } else {
        try { this.proc.kill("SIGINT"); } catch { }
        this._forceKillTimer = setTimeout(() => {
          if (this.proc && !this.proc.killed) {
            try { this.proc.kill("SIGKILL"); } catch { }
          }
        }, 2000);
        this._forceKillTimer.unref();
      }
    });

    return this._stopPromise;
  }

  async restart() {
    if (this.state.mining.status === "STARTING" || this.state.mining.status === "STOPPING") return;
    await this.stop();
    await new Promise(r => setTimeout(r, 500));
    await this.start();
  }
}

module.exports = {
  MinerManager
};
