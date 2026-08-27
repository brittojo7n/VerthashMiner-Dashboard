"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { parseMinerLine } = require("./parser");
const { STATUS, LOG, LIMITS } = require("../utils/constants");
const { parseCudaDeviceList, createStreamReader } = require("./devices");
const { unrefTimer: timer } = require("../utils/timers");

const SHELL_METACHAR_RE = /[;&|`$()\n\r<>]/;

function containsShellMetachars(str) {
  return SHELL_METACHAR_RE.test(str);
}

const ACTIONS = Object.freeze({
  start: STATUS.STARTING,
  stop: STATUS.STOPPING,
  restart: STATUS.RESTARTING,
});

const CLEAN_STATS = Object.freeze({
  hashrateKHs: null,
  accepted: 0,
  submitted: 0,
  rejected: 0,
  difficulty: null,
  lastAcceptedAt: null,
  hashratesReady: false,
  expectedWorkers: 0,
  jsonRejects: 0,
});

function resolveExe(exe, cwd) {
  if (!exe || containsShellMetachars(exe)) return null;
  const looksLikePath = exe.includes("/") || exe.includes("\\");
  const candidate = path.resolve(cwd || ".", exe);
  if (looksLikePath) return candidate;
  try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  return exe;
}

function sanitizeArgs(args) {
  return args.filter((arg) => typeof arg === "string" && !containsShellMetachars(arg));
}

class MinerManager {
  constructor({ config, state, onUpdate, timeouts = {} }) {
    this.config = config;
    this.state = state;
    this.onUpdate = onUpdate;
    this.timeouts = {
      probe: timeouts.probe ?? LIMITS.PROBE_TIMEOUT_MS,
      forceKill: timeouts.forceKill ?? LIMITS.FORCE_KILL_MS,
      stop: timeouts.stop ?? LIMITS.STOP_TIMEOUT_MS,
      restartGap: timeouts.restartGap ?? LIMITS.RESTART_GAP_MS,
    };
    this.proc = null;
    this.isStoppingChild = false;
    this._stopPromise = null;
    this._forceKillTimer = null;
    this._actionTimer = null;
    this._pendingAction = null;
    this._statusRollback = null;
    this._spawning = false;
    this._probe = null;
    this._subscribers = 0;
    this.state.mining.workerMap = config.DEVICE_SELECTION || null;
  }

  _emit() {
    if (typeof this.onUpdate === "function") {
      try {
        this.onUpdate();
      } catch (err) {}
    }
  }

  _setMining(patch) {
    Object.assign(this.state.mining, patch);
    this.state.dirty = true;
  }

  _resetStats() {
    this._setMining({ ...CLEAN_STATS });
    this.state.mining.gpuHashrates = Object.create(null);
    this.state.mining.seenDevices = [];
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


  get _alive() {
    return Boolean(this.state.miner.running || this.proc || this._spawning);
  }

  start() {
    if (this._stopPromise) return this._stopPromise.then(() => this.start());
    if (this.proc || this.state.miner.running || this._spawning)
      return Promise.resolve();

    this._resetStats();
    this.state.miner.lastError = "";

    const { MINER_ARGS, MINER_CWD } = this.config;
    if (!MINER_CWD || !MINER_ARGS.length) {
      const message = `${MINER_CWD ? "MINER_ARGS" : "MINER_CWD"} not configured in .env`;
      this.state.miner.lastError = message;
      this._setMining({ status: STATUS.STOPPED });
      this.pushLog(message, LOG.WARN);
      this._emit();
      return Promise.resolve();
    }

    this._spawning = true;
    this._setMining({ status: STATUS.STARTING });
    this.pushLog("Starting miner...", LOG.SYSTEM);
    this._emit();

    return new Promise((resolve) => {
      this._probeDevices(() => {
        if (this._spawning) this._spawnMiner();
        resolve();
      });
    });
  }

  _probeDevices(done) {
    const { MINER_CWD } = this.config;
    const MINER_EXE = resolveExe(this.config.MINER_EXE, MINER_CWD);
    if (!MINER_EXE) {
      this._markDown(STATUS.CRASHED, "Invalid miner executable path");
      done();
      return;
    }
    let finished = false;
    let watchdog = null;

    const once = () => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      this._probe = null;
      done();
    };

    let probe;
    try {
      probe = spawn(MINER_EXE, ["--device-list"], {
        cwd: MINER_CWD,
        windowsHide: true,
        shell: false,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      console.error("[dashboard] probe spawn failed:", err.message);
      once();
      return;
    }

    this._probe = probe;
    let buffer = "";
    const collect = (chunk) => {
      if (buffer.length < LIMITS.STREAM_BUFFER_BYTES) buffer += chunk;
    };
    probe.stdout.on("data", collect);
    probe.stderr.on("data", collect);
    probe.on("close", () => {
      try {
        parseCudaDeviceList(buffer, this.state.mining.pciMap);
      } catch (err) {
        console.error("[dashboard] probe parse failed:", err.message);
      }
      once();
    });
    probe.on("error", once);

    watchdog = timer(() => {
      if (finished) return;
      this.pushLog("Device probe timed out; continuing without PCI mapping.", LOG.WARN);
      try {
        probe.kill("SIGKILL");
      } catch (err) {
        console.error("[dashboard] probe kill failed:", err.message);
      }
      once();
    }, this.timeouts.probe);
  }

  _spawnMiner() {
    const { MINER_ARGS, MINER_CWD, FORWARD_CONSOLE } = this.config;
    const MINER_EXE = resolveExe(this.config.MINER_EXE, MINER_CWD);
    if (!MINER_EXE) {
      this._markDown(STATUS.CRASHED, "Invalid miner executable path");
      this._emit();
      return;
    }
    const safeArgs = sanitizeArgs(MINER_ARGS);

    try {
      this.proc = spawn(MINER_EXE, safeArgs, {
        cwd: MINER_CWD,
        windowsHide: false,
        shell: false,
        detached: false,
        stdio: ["inherit", "pipe", "pipe"],
      });
    } catch (err) {
      this._markDown(STATUS.CRASHED, err.message);
      this.pushLog(err.message, LOG.ERROR);
      this._emit();
      return;
    }

    const child = this.proc;

    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_NORMAL);
    } catch (err) {
      console.error("[dashboard] setPriority failed:", err.message);
    }

    this._spawning = false;
    this.state.miner.running = true;
    this.state.miner.pid = child.pid;
    this.state.miner.startedAt = Date.now();
    this.state.miner.exitCode = null;
    this.state.miner.signal = null;
    this._setMining({ status: STATUS.STARTING });
    this._emit();

    this._bindStreams(child, FORWARD_CONSOLE);
    this._bindLifecycle(child);
  }

  _bindStreams(child, forwardConsole) {
    const onLine = (line) => {
      try { parseMinerLine(line, this.state, this._boundPushLog()); }
      catch (err) { this.state.dirty = true; }
    };
    const onFlush = () => this._emit();
    const alwaysEnabled = () => true;
    const mirror = forwardConsole ? (s) => (c) => { try { s.write(c); } catch {} } : null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", createStreamReader(onLine, onFlush, alwaysEnabled, mirror ? mirror(process.stdout) : null));
    child.stderr.on("data", createStreamReader(onLine, onFlush, alwaysEnabled, mirror ? mirror(process.stderr) : null));
    const ignoreErr = () => {};
    child.stdout.on("error", ignoreErr);
    child.stderr.on("error", ignoreErr);
  }

  _bindLifecycle(child) {
    let settled = false;
    child.on("error", (err) => {
      if (settled) return; settled = true;
      this._markDown(STATUS.CRASHED, err.message);
      this.pushLog(err.message, LOG.ERROR);
      if (this.proc === child) this.proc = null;
      this._emit();
    });
    const onGone = (code, signal) => {
      if (settled) return; settled = true;
      const { status } = this.state.mining;
      const deliberate = status === STATUS.STOPPING || status === STATUS.STOPPED;
      const next = deliberate ? status : code === 0 && !signal ? STATUS.STOPPED : STATUS.CRASHED;
      this._markDown(next);
      this.state.miner.exitCode = code;
      this.state.miner.signal = signal;
      this.state.miner.pid = null;
      this.pushLog(`Exited (code: ${code}${signal ? `, sig: ${signal}` : ""})`, LOG.SYSTEM);
      if (this.proc === child) this.proc = null;
      this._emit();
    };
    child.on("exit", onGone);
    child.on("close", onGone);
  }

  _boundPushLog() {
    return (this._pushLogBound ||= (text, type) => this.pushLog(text, type));
  }

  _clearScheduledAction() {
    clearTimeout(this._actionTimer);
    this._actionTimer = null;
    if (this._pendingAction && this._statusRollback && this.proc && this.state.miner.running) {
      this._setMining({ status: this._statusRollback });
      this._emit();
    }
    this._pendingAction = null;
    this._statusRollback = null;
  }

  _markStopped() {
    this.state.miner.running = false;
    this._setMining({ status: STATUS.STOPPED });
    this._emit();
  }

  requestAction(action) {
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) return;
    if (this._pendingAction === action) return;
    const idle = !this.state.miner.running && !this.proc && this._pendingAction !== "start";
    if (action === "start" && this._alive) return this._clearScheduledAction();
    if (action === "stop" && idle) { if (this.state.mining.status !== STATUS.STOPPED) this._markStopped(); return; }
    if (action === "restart" && idle) return this.requestAction("start");
    this._clearScheduledAction();
    this._pendingAction = action;
    this._statusRollback = this.state.mining.status;
    this._setMining({ status: ACTIONS[action] });
    this._emit();
    this._actionTimer = timer(() => {
      const pending = this._pendingAction;
      this._actionTimer = null; this._pendingAction = null; this._statusRollback = null;
      if (pending && typeof this[pending] === "function")
        Promise.resolve().then(() => this[pending]()).catch((err) => { this.pushLog(`Action "${pending}" failed: ${err && err.message}`, LOG.ERROR); this._emit(); });
    }, LIMITS.ACTION_DELAY_MS);
  }

  stop() {
    this._clearScheduledAction();
    this._spawning = false;
    if (!this.proc || !this.state.miner.running) {
      if (this.state.mining.status !== STATUS.STOPPED) this._markStopped();
      return Promise.resolve();
    }
    if (this._stopPromise) return this._stopPromise;
    this._setMining({ status: STATUS.STOPPING });
    this._emit();
    const child = this.proc;
    const pid = child.pid;
    this.isStoppingChild = true;
    this._stopPromise = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return; settled = true;
        clearTimeout(this._forceKillTimer); clearTimeout(watchdog);
        this._forceKillTimer = null;
        if (this.proc === child) this.proc = null;
        this._setMining({ status: STATUS.STOPPED });
        this.state.miner.running = false;
        this._stopPromise = null; this.isStoppingChild = false;
        resolve();
      };
      child.once("close", finish);
      child.once("exit", finish);
      const forceKill = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform === "win32")
          execFile("taskkill.exe", ["/pid", String(pid), "/T", "/F"], { shell: false }, () => {});
        else try { child.kill("SIGKILL"); } catch {}
      };
      try { child.kill("SIGINT"); } catch {}
      this._forceKillTimer = timer(forceKill, this.timeouts.forceKill);
      var watchdog = timer(() => {
        if (settled) return;
        this.pushLog("Miner did not exit in time; giving up on a clean stop.", LOG.WARN);
        forceKill(); finish();
      }, this.timeouts.stop);
    });
    return this._stopPromise;
  }

  async restart() {
    if (this._spawning || this._stopPromise) return;
    await this.stop();
    await new Promise((r) => timer(r, this.timeouts.restartGap));
    await this.start();
  }

  dispose() {
    this._clearScheduledAction();
    clearTimeout(this._forceKillTimer); this._forceKillTimer = null;
    if (this._probe) { try { this._probe.kill("SIGKILL"); } catch {} this._probe = null; }
  }
}

module.exports = { MinerManager };
