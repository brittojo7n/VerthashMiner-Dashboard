"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { parseMinerLine } = require("./parser");
const { STATUS, LOG, LIMITS } = require("./constants");
const { parseCudaDeviceList, createStreamReader } = require("./devices");

const ACTIONS = Object.freeze({
  start: STATUS.STARTING,
  stop: STATUS.STOPPING,
  restart: STATUS.RESTARTING
});

/** Fields reset on every (re)start so a new run never inherits stale numbers. */
const CLEAN_STATS = Object.freeze({
  hashrateKHs: null,
  accepted: 0,
  submitted: 0,
  rejected: 0,
  difficulty: null,
  lastAcceptedAt: null,
  hashratesReady: false,
  expectedWorkers: 0,
  lastJsonRejectTime: 0
});

/**
 * Resolves the miner executable.
 *
 * Windows' CreateProcess searches the working directory, POSIX' execvp does
 * not. Resolving a bare name against MINER_CWD first makes both platforms
 * behave the way the README describes, and still falls back to PATH.
 *
 * @param {string} exe MINER_EXE
 * @param {string} cwd MINER_CWD
 */
function resolveExe(exe, cwd) {
  if (!exe) return exe;
  const looksLikePath = exe.includes("/") || exe.includes("\\");
  const candidate = path.resolve(cwd || ".", exe);
  if (looksLikePath) return candidate;
  try {
    if (fs.statSync(candidate).isFile()) return candidate;
  } catch {
    /* not next to the miner: fall back to a PATH lookup */
  }
  return exe;
}

/** setTimeout that never keeps the event loop alive. */
function timer(fn, ms) {
  const handle = setTimeout(fn, ms);
  if (typeof handle.unref === "function") handle.unref();
  return handle;
}

/**
 * Supervises the VerthashMiner child process: spawn, stream parsing,
 * lifecycle actions and shutdown, with a watchdog on every asynchronous step
 * so a wedged child can never wedge the dashboard.
 */
class MinerManager {
  constructor({ config, state, onUpdate, timeouts = {} }) {
    this.config = config;
    this.state = state;
    this.onUpdate = onUpdate;
    this.timeouts = {
      probe: timeouts.probe ?? LIMITS.PROBE_TIMEOUT_MS,
      forceKill: timeouts.forceKill ?? LIMITS.FORCE_KILL_MS,
      stop: timeouts.stop ?? LIMITS.STOP_TIMEOUT_MS,
      restartGap: timeouts.restartGap ?? LIMITS.RESTART_GAP_MS
    };

    this.proc = null;
    this.parsingEnabled = false;
    this.isStoppingChild = false;

    this._stopPromise = null;
    this._forceKillTimer = null;
    this._actionTimer = null;
    this._pendingAction = null;
    this._spawning = false;
    this._probe = null;

    // Worker slot -> device index mapping (only differs for device subsets).
    this.state.mining.workerMap = config.DEVICE_SELECTION || null;
  }

  /* ---------------------------------------------------------------- helpers */

  _emit() {
    if (this.parsingEnabled && typeof this.onUpdate === "function") this.onUpdate();
  }

  _setMining(patch) {
    Object.assign(this.state.mining, patch);
    this.state.dirty = true;
  }

  _resetStats() {
    this._setMining({ ...CLEAN_STATS });
    // Recreate rather than mutate: keeps the hidden class stable and drops any
    // device that disappeared between runs.
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

  enableParsing() {
    this.parsingEnabled = true;
    this._emit();
  }

  disableParsing() {
    this.parsingEnabled = false;
  }

  get _alive() {
    return Boolean(this.state.miner.running || this.proc || this._spawning);
  }

  /* ------------------------------------------------------------------ start */

  start() {
    if (this._stopPromise) return this._stopPromise.then(() => this.start());
    if (this.proc || this.state.miner.running || this._spawning) return Promise.resolve();

    this._resetStats();

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

    // Resolves once the spawn attempt is done, so callers (and tests) have a
    // deterministic point at which `state.miner` is authoritative.
    return new Promise(resolve => {
      this._probeDevices(() => {
        // The user may have pressed STOP while the probe was running.
        if (this._spawning) this._spawnMiner();
        resolve();
      });
    });
  }

  /**
   * Runs `--device-list` to learn the PCI id -> CUDA index mapping.
   * Always calls `done()` exactly once, even if the probe hangs or the binary
   * is missing: the miner start must never depend on it succeeding.
   */
  _probeDevices(done) {
    const { MINER_CWD } = this.config;
    const MINER_EXE = resolveExe(this.config.MINER_EXE, MINER_CWD);
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
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      once();
      return;
    }

    this._probe = probe;

    let buffer = "";
    const collect = chunk => {
      if (buffer.length < LIMITS.STREAM_BUFFER_BYTES) buffer += chunk;
    };
    probe.stdout.on("data", collect);
    probe.stderr.on("data", collect);
    probe.on("close", () => {
      try {
        parseCudaDeviceList(buffer, this.state.mining.pciMap);
      } catch {
        /* a malformed device list must not block the miner */
      }
      once();
    });
    probe.on("error", once);

    watchdog = timer(() => {
      if (finished) return;
      this.pushLog("Device probe timed out; continuing without PCI mapping.", LOG.WARN);
      try {
        probe.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      once();
    }, this.timeouts.probe);
  }

  _spawnMiner() {
    const { MINER_ARGS, MINER_CWD, FORWARD_CONSOLE } = this.config;
    const MINER_EXE = resolveExe(this.config.MINER_EXE, MINER_CWD);

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

    const child = this.proc;
    let settled = false;

    this._spawning = false;
    this.state.miner.running = true;
    this.state.miner.pid = child.pid;
    this.state.miner.startedAt = Date.now();
    this.state.miner.exitCode = null;
    this.state.miner.signal = null;
    this._setMining({ status: STATUS.STARTING });
    this._emit();

    const onLine = (line, enabled) => {
      try {
        parseMinerLine(line, this.state, enabled ? this._boundPushLog() : undefined);
      } catch {
        // A parser fault must never take the supervisor (or the miner) down.
        this.state.dirty = true;
      }
    };
    const onFlush = () => this._emit();
    const enabled = () => this.parsingEnabled;
    const mirror = stream => (FORWARD_CONSOLE ? chunk => stream.write(chunk) : null);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", createStreamReader(onLine, onFlush, enabled, mirror(process.stdout)));
    child.stderr.on("data", createStreamReader(onLine, onFlush, enabled, mirror(process.stderr)));

    // Broken pipes are expected during shutdown; swallow them explicitly so
    // they can never become an uncaught 'error' event.
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    child.on("error", err => {
      if (settled) return;
      settled = true;
      this._markDown(STATUS.CRASHED, err.message);
      this.pushLog(err.message, LOG.ERROR);
      this.proc = null;
      this._emit();
    });

    const onGone = (code, signal) => {
      if (settled) return;
      settled = true;
      const { status } = this.state.mining;
      const deliberate = status === STATUS.STOPPING || status === STATUS.STOPPED;
      // An unrequested death by signal is a crash, not a clean stop.
      const next = deliberate ? status : code === 0 && !signal ? STATUS.STOPPED : STATUS.CRASHED;

      this._markDown(next);
      this.state.miner.exitCode = code;
      this.state.miner.signal = signal;
      this.state.miner.pid = null;
      this.pushLog(`Exited (code: ${code}${signal ? `, sig: ${signal}` : ""})`, LOG.SYSTEM);
      if (this.proc === child) this.proc = null;
      this._emit();
    };

    // 'exit' fires before 'close'; whichever wins, the transition happens once.
    child.on("exit", onGone);
    child.on("close", onGone);
  }

  _boundPushLog() {
    return (this._pushLogBound ||= (text, type) => this.pushLog(text, type));
  }

  /* ----------------------------------------------------------------- action */

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

  /**
   * Debounced UI control entry point. Returns immediately; the actual
   * lifecycle call happens after ACTION_DELAY_MS so a double click cannot
   * produce two spawns.
   */
  requestAction(action) {
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) return;
    if (this._pendingAction === action) return;

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

    this._actionTimer = timer(() => {
      const pending = this._pendingAction;
      this._actionTimer = null;
      this._pendingAction = null;
      if (pending && typeof this[pending] === "function") {
        Promise.resolve()
          .then(() => this[pending]())
          .catch(err => {
            this.pushLog(`Action "${pending}" failed: ${err && err.message}`, LOG.ERROR);
            this._emit();
          });
      }
    }, LIMITS.ACTION_DELAY_MS);
  }

  /* ------------------------------------------------------------------- stop */

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

    this._stopPromise = new Promise(resolve => {
      let settled = false;
      let watchdog = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(this._forceKillTimer);
        clearTimeout(watchdog);
        this._forceKillTimer = null;
        if (this.proc === child) this.proc = null;
        this._setMining({ status: STATUS.STOPPED });
        this.state.miner.running = false;
        this._stopPromise = null;
        this.isStoppingChild = false;
        resolve();
      };

      child.once("close", finish);
      child.once("exit", finish);

      const forceKill = () => {
        // NOTE: `child.killed` only means "a signal was delivered", so it is
        // true right after the SIGINT above. Escalation must be driven by
        // whether the process actually exited.
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      };

      if (process.platform === "win32") {
        // taskkill /T tears down the whole tree (the miner spawns worker
        // threads only, but a wrapper .cmd would add a level).
        execFile("taskkill.exe", ["/pid", String(pid), "/T", "/F"], () => {});
        this._forceKillTimer = timer(forceKill, this.timeouts.forceKill);
      } else {
        try {
          child.kill("SIGINT");
        } catch {
          /* already gone */
        }
        this._forceKillTimer = timer(forceKill, this.timeouts.forceKill);
      }

      // Absolute ceiling: never leave the caller awaiting forever.
      watchdog = timer(() => {
        if (settled) return;
        this.pushLog("Miner did not exit in time; giving up on a clean stop.", LOG.WARN);
        forceKill();
        finish();
      }, this.timeouts.stop);
    });

    return this._stopPromise;
  }

  async restart() {
    if (this._spawning || this._stopPromise) return;
    await this.stop();
    await new Promise(resolve => timer(resolve, this.timeouts.restartGap));
    await this.start();
  }

  /** Releases every timer/child this manager owns (used by tests and shutdown). */
  dispose() {
    this._clearScheduledAction();
    clearTimeout(this._forceKillTimer);
    this._forceKillTimer = null;
    if (this._probe) {
      try {
        this._probe.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      this._probe = null;
    }
  }
}

module.exports = { MinerManager, parseCudaDeviceList, resolveExe };
