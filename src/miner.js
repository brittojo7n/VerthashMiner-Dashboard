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
  }

  pushLog(text, type = "info") {
    if (this.state?.miner?.logs) {
      this.state.miner.logs.push(text, type);
      this.state.miner.lastLine = text;
    }
  }

  start() {
    const { MINER_EXE, MINER_ARGS, MINER_CWD } = this.config;

    if (!MINER_CWD || !MINER_ARGS.length) {
      const msg = !MINER_CWD ? "MINER_CWD not configured in .env" : "MINER_ARGS not configured in .env";
      this.state.miner.lastError = msg;
      this.state.mining.status = "STOPPED";
      this.pushLog(msg, "warn");
      return;
    }

    this.pushLog(`Starting: ${MINER_EXE} ${MINER_ARGS.join(" ")}`, "info");

    this.proc = spawn(MINER_EXE, MINER_ARGS, {
      cwd: MINER_CWD,
      windowsHide: false,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.state.miner.running = true;
    this.state.mining.status = "STARTING";

    const handleLine = line => parseMinerLine(line, this.state, (l, t) => this.pushLog(l, t));
    const handleFlush = () => {
      if (typeof this.onUpdate === "function") this.onUpdate();
    };

    const stdoutReader = createStreamReader(handleLine, handleFlush);
    const stderrReader = createStreamReader(handleLine, handleFlush);

    this.proc.stdout.on("data", stdoutReader);
    this.proc.stderr.on("data", stderrReader);

    this.proc.on("error", err => {
      this.state.miner.running = false;
      this.state.miner.lastError = err.message;
      this.state.mining.status = "ERROR";
      this.pushLog(err.message, "error");
      if (typeof this.onUpdate === "function") this.onUpdate();
    });

    this.proc.on("close", (code, sig) => {
      this.state.miner.running = false;
      this.state.miner.exitCode = code;
      this.state.mining.status = "STOPPED";
      this.pushLog(`Exited (code: ${code}${sig ? `, sig: ${sig}` : ""})`, code === 0 ? "info" : "warn");
      this.proc = null;
      if (typeof this.onUpdate === "function") this.onUpdate();
    });
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill();
      } catch { }
    }
    this.proc = null;
  }
}

module.exports = {
  createStreamReader,
  MinerManager
};
