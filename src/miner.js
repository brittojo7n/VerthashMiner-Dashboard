"use strict";

const { spawn, execFile } = require("node:child_process");
const { parseMinerLine } = require("./parser");
const { STATUS, LOG, LIMITS } = require("./constants");
const { parseCudaDeviceList, createStreamReader, stripAnsi } = require("./devices");

const ACTIONS = Object.freeze({
  start: STATUS.STARTING,
  stop: STATUS.STOPPING,
  restart: STATUS.RESTARTING
});
const FORCE_KILL_MS = 2000;
const RESTART_GAP_MS = 500;

const CLEAN_STATS = Object.freeze({
  hashrateKHs: null,
  accepted: 0,
  submitted: 0,
  rejected: 0,
  difficulty: null,
  lastAcceptedAt: null,
  hashratesReady: false
});

class MinerManager {
  constructor({ config, state, onUpdate }) {
    this.config = config;
    this.state = state;
    this.onUpdate = onUpdate;

    this.proc = null;
    this.parsingEnabled = false;
    this.isStoppingChild = false;
    this.history = [];

    this._stopPromise = null;
    this._forceKillTimer = null;
    this._actionTimer = null;
    this._pendingAction = null;
    this._spawning = false;
  }

  _emit() {
    if (this.parsingEnabled) this.onUpdate?.();
  }

  _setMining(patch) {
    Object.assign(this.state.mining, patch);
    this.state.dirty = true;
  }

  _resetStats() {
    this._setMining({ ...CLEAN_STATS, gpuHashrates: {} });
  }

  _markDown(status, error) {
    this._spawning = false;
    this.isStoppingChild = false;
    this.state.miner.running = false;
    if (error) this.state.miner.lastError = error;
    this._setMining({ status });
    this._resetStats();
  }

  pushLog(text, type = LOG.INFO) {
    const logs = this.state.miner.logs;
    if (!logs) return;
    logs.push(text, type);
    this.state.miner.lastLine = text;
    this.state.dirty = true;
  }

  enableParsing() {
    if (this.parsingEnabled) return;
    this.parsingEnabled = true;
    if (this.state.miner.running) {
      for (const line of this.history) parseMinerLine(line, this.state, () => {});
    }
    this.history.length = 0;
  }

  disableParsing() {
    this.parsingEnabled = false;
  }

  start() {
    if (this._stopPromise) return this._stopPromise.then(() => this.start());
    if (this.proc || this.state.miner.running || this._spawning) return Promise.resolve();

    this._resetStats();

    const { MINER_EXE, MINER_ARGS, MINER_CWD } = this.config;
    if (!MINER_CWD || !MINER_ARGS.length) {
      const message = `${MINER_CWD ? "MINER_ARGS" : "MINER_CWD"} not configured in .env`;
      this.state.miner.lastError = message;
      this._setMining({ status: STATUS.STOPPED });
      this.pushLog(message, LOG.WARN);
      return Promise.resolve();
    }

    this._spawning = true;
    this._setMining({ status: STATUS.STARTING });
    this.pushLog("Starting miner...", LOG.SYSTEM);
    this._emit();

    this._probeDevices(() => this._spawnMiner());
    return Promise.resolve();
  }

  _probeDevices(done) {
    const { MINER_EXE, MINER_CWD } = this.config;
    let finished = false;
    const once = () => { if (!finished) { finished = true; done(); } };

    try {
      const probe = spawn(MINER_EXE, ["--device-list"], {
        cwd: MINER_CWD, windowsHide: true, shell: false, detached: false
      });

      let buffer = "";
      const collect = chunk => {
        if (buffer.length < LIMITS.STREAM_BUFFER_BYTES) buffer += chunk;
      };
      probe.stdout.on("data", collect);
      probe.stderr.on("data", collect);
      probe.on("close", () => {
        parseCudaDeviceList(buffer, this.state.mining.pciMap);
        once();
      });
      probe.on("error", once);
    } catch {
      once();
    }
  }

  _spawnMiner() {
    const { MINER_EXE, MINER_ARGS, MINER_CWD, FORWARD_CONSOLE } = this.config;

    try {
      this.proc = spawn(MINER_EXE, MINER_ARGS, {
        cwd: MINER_CWD,
        windowsHide: false,
        shell: false,
        detached: false,
        stdio: ["inherit", "pipe", "pipe"]
      });
    } catch (err) {
      this._markDown(STATUS.CRASHED, err.message);
      this.pushLog(err.message, LOG.ERROR);
      this._emit();
      return;
    }

    this._spawning = false;
    this.state.miner.running = true;
    this.state.miner.pid = this.proc.pid;
    this.state.miner.startedAt = Date.now();
    this._setMining({ status: STATUS.STARTING });
    this._emit();

    const onLine = (line, enabled) => {
      if (enabled) {
        parseMinerLine(line, this.state, (text, type) => this.pushLog(text, type));
        return;
      }

      this.history.push(line);
      if (this.history.length > LIMITS.REPLAY_LINES) this.history.shift();
      const clean = stripAnsi(line).trim();
      if (clean) this.pushLog(clean, LOG.INFO);
    };

    const onFlush = () => this._emit();
    const enabled = () => this.parsingEnabled;
    const mirror = stream => (FORWARD_CONSOLE ? chunk => stream.write(chunk) : null);

    this.proc.stdout.on("data", createStreamReader(onLine, onFlush, enabled, mirror(process.stdout)));
    this.proc.stderr.on("data", createStreamReader(onLine, onFlush, enabled, mirror(process.stderr)));

    this.proc.on("error", err => {
      this._markDown(STATUS.CRASHED, err.message);
      this.pushLog(err.message, LOG.ERROR);
      this._emit();
    });

    this.proc.on("close", (code, signal) => {
      const { status } = this.state.mining;
      const deliberate = status === STATUS.STOPPING || status === STATUS.STOPPED;
      const next = deliberate ? status
        : (code === 0 || code === null) ? STATUS.STOPPED : STATUS.CRASHED;

      this._markDown(next);
      this.state.miner.exitCode = code;
      this.state.miner.signal = signal;
      this.pushLog(`Exited (code: ${code}${signal ? `, sig: ${signal}` : ""})`, LOG.SYSTEM);
      this.proc = null;
      this._emit();
    });
  }

  _clearScheduledAction() {
    clearTimeout(this._actionTimer);
    this._actionTimer = null;
    this._pendingAction = null;
  }

  _markStopped() {
    this.state.miner.running = false;
    this._setMining({ status: STATUS.STOPPED });
    this._emit();
  }

  get _alive() {
    return Boolean(this.state.miner.running || this.proc || this._spawning);
  }

  requestAction(action) {
    if (!(action in ACTIONS) || this._pendingAction === action) return;

    const idle = !this.state.miner.running && !this.proc && this._pendingAction !== "start";
    if (action === "start" && this._alive) return this._clearScheduledAction();
    if (action === "stop" && idle) {
      if (this.state.mining.status !== STATUS.STOPPED) this._markStopped();
      return;
    }
    if (action === "restart" && idle) return this.requestAction("start");

    this._clearScheduledAction();
    this._pendingAction = action;
    this._setMining({ status: ACTIONS[action] });
    this._emit();

    this._actionTimer = setTimeout(() => {
      const pending = this._pendingAction;
      this._actionTimer = null;
      this._pendingAction = null;
      this[pending]?.();
    }, LIMITS.ACTION_DELAY_MS);
  }

  stop() {
    this._clearScheduledAction();

    if (!this.proc || !this.state.miner.running) {
      if (this.state.mining.status !== STATUS.STOPPED) this._markStopped();
      return Promise.resolve();
    }
    if (this._stopPromise) return this._stopPromise;

    this._setMining({ status: STATUS.STOPPING });
    this._emit();

    const pid = this.proc.pid;
    const child = this.proc;
    this.isStoppingChild = true;

    this._stopPromise = new Promise(resolve => {
      const finish = () => {
        clearTimeout(this._forceKillTimer);
        this._forceKillTimer = null;
        this.proc = null;
        this._setMining({ status: STATUS.STOPPED });
        this._stopPromise = null;
        this.isStoppingChild = false;
        resolve();
      };

      child.once("close", finish);
      child.once("exit", finish);

      if (process.platform === "win32") {
        execFile("taskkill.exe", ["/pid", String(pid), "/T", "/F"]);
        return;
      }

      try { child.kill("SIGINT"); } catch {  }
      this._forceKillTimer = setTimeout(() => {
        if (this.proc && !this.proc.killed) {
          try { this.proc.kill("SIGKILL"); } catch {  }
        }
      }, FORCE_KILL_MS);
      this._forceKillTimer.unref();
    });

    return this._stopPromise;
  }

  async restart() {
    if (this._spawning || this._stopPromise) return;
    await this.stop();

    await new Promise(resolve => setTimeout(resolve, RESTART_GAP_MS));
    await this.start();
  }
}

module.exports = { MinerManager, parseCudaDeviceList };
