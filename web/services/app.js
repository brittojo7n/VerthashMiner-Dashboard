import "./perf.js";
import { el, text, className, make } from "../lib/dom.js";
import { createModal } from "../components/modal.js";
import { presentSnapshot, sharesPerMinute, dotClass, timestamp, uptime, stripLogPrefix, DASH, IDLE_STATUS as IDLE, LIVE_STATUS as LIVE } from "../lib/present.js";
import * as toast from "../components/toast.js";
import * as gpuView from "../components/gpu.js";
import { createMetric } from "../components/metric.js";
import { createIdentity } from "../components/identity.js";
import { createConsole } from "../components/console.js";
import { createConnection } from "./connection.js";

const ACTION_META = {
  start: { status: "STARTING", label: "START", toast: ["Starting Miner", "Launching the VerthashMiner process."] },
  stop: { status: "STOPPING", label: "STOP", toast: ["Stopping Miner", "Shutting down the VerthashMiner process."] },
  restart: { status: "RESTARTING", label: "RESTART", toast: ["Restarting Miner", "Stopping and relaunching the VerthashMiner process."] },
};

function buildAuthContent() {
  const wrap = make("div");
  wrap.appendChild(make("h2", null, "Login"));
  wrap.appendChild(make("p", null, "Enter your passphrase to access the dashboard."));
  const input = make("input", "modal-input");
  input.type = "password";
  input.placeholder = "Passphrase";
  const err = make("div", "modal-error", "Invalid passphrase");
  const submit = make("button", "modal-btn", "Login");
  submit.type = "button";
  wrap.append(input, err, submit);
  return { wrap, input, err, submit };
}

function buildConfirmContent() {
  const wrap = make("div");
  const title = make("h2", null, "Confirm Action");
  const desc = make("p", null, "Are you sure you want to proceed?");
  const group = make("div", "btn-group");
  const cancel = make("button", "modal-btn modal-btn-cancel", "Cancel");
  cancel.type = "button";
  const yes = make("button", "modal-btn modal-btn-start", "START");
  yes.type = "button";
  group.append(cancel, yes);
  wrap.append(title, desc, group);
  return { wrap, title, desc, cancel, yes };
}

function buildSummary(host) {
  const cards = {
    hashrate: createMetric({ label: "Total Hashrate", value: DASH, unit: "kH/s", accent: "cyan", surface: 1 }),
    accepted: createMetric({ label: "Shares (Acc / Sub)", value: DASH, accent: "green", surface: 1 }),
    ratio: createMetric({ label: "Acceptance Ratio", value: DASH, surface: 1 }),
    uptime: createMetric({ label: "Uptime", value: DASH, surface: 1 }),
  };
  for (const card of Object.values(cards)) host.appendChild(card.node);
  return cards;
}

function buildMiningMetrics(host) {
  const cards = {
    rejected: createMetric({ label: "Rejected", value: "0", accent: "red", surface: 2 }),
    spm: createMetric({ label: "Shares Per Minute", value: DASH, accent: "green", surface: 2 }),
    difficulty: createMetric({ label: "Network Difficulty", value: DASH, accent: "violet", surface: 2 }),
    lastAccepted: createMetric({ label: "Last Share", value: DASH, surface: 2, small: true }),
  };
  for (const card of Object.values(cards)) host.appendChild(card.node);
  return cards;
}

class Dashboard {
  constructor() {
    this.els = {
      dot: el("dot"), status: el("status"), host: el("host"), btnAction: el("btnAction"),
      btnRestart: el("btnRestart"), error: el("error"), gpus: el("gpus"),
      localTime: el("localTime"), btnAutoScroll: el("btnAutoScroll"), refresh: el("btnRefresh"),
    };
    this.summary = buildSummary(el("summary"));
    this.identity = createIdentity();
    el("identity").appendChild(this.identity.node);
    this.mining = buildMiningMetrics(el("miningMetrics"));
    this.modal = createModal();
    this.auth = buildAuthContent();
    this.confirm = buildConfirmContent();
    this.consoleView = createConsole({
      terminal: el("terminal"), lines: el("logLines"), counter: el("logCount"),
      onAutoScrollChange: this.onAutoScroll.bind(this),
    });
    this.serverNow = null;
    this.capturedAt = 0;
    this.startedAt = null;
    this.tz = null;
    this.accepted = 0;
    this.ticker = null;
    this.pendingStatus = null;
    this.lastError = null;
    this.lastGpuError = null;
    this.lastStatus = null;
    this.armedAction = null;
    this.refreshing = false;
    this.connection = createConnection({
      onSnapshot: this.render.bind(this),
      onUnauthorized: this.showAuth.bind(this),
      onLive: () => this.modal.close(),
      onCountdown: (message) => text(this.els.host, message),
      onStatusText: this.onStatusText.bind(this),
    });
    this.bindEvents();
    gpuView.render(this.els.gpus, [], "");
    this.connection.connect();
  }

  tick() {
    if (this.serverNow == null) return;
    const now = this.serverNow + (Date.now() - this.capturedAt);
    text(this.els.localTime, timestamp(now, this.tz));
    if (this.startedAt) {
      const elapsed = Math.max(0, now - this.startedAt);
      this.summary.uptime.set({ value: uptime(Math.floor(elapsed / 1000)) });
      this.mining.spm.set({ value: sharesPerMinute(this.accepted, elapsed) });
    } else {
      this.summary.uptime.set({ value: DASH });
      this.mining.spm.set({ value: DASH });
    }
  }

  startClock() {
    this.ticker ||= setInterval(this.tick.bind(this), 1000);
  }

  stopClock() {
    clearInterval(this.ticker);
    this.ticker = null;
  }

  applyChrome(status, locked) {
    text(this.els.status, status);
    const idle = IDLE.has(status);
    const busy = locked || (!idle && !LIVE.has(status));
    className(this.els.dot, dotClass(status));
    text(this.els.btnAction, idle ? "START" : "STOP");
    className(this.els.btnAction, `c-btn ${idle ? "btn-start" : "btn-stop"}`);
    this.els.btnAction.disabled = busy;
    this.els.btnRestart.disabled = busy || idle;
  }

  onAutoScroll(on) {
    className(this.els.btnAutoScroll, `c-btn${on ? " active" : ""}`);
    text(this.els.btnAutoScroll, `Auto-scroll: ${on ? "ON" : "OFF"}`);
  }

  announce(status) {
    if (this.lastStatus !== null && status !== this.lastStatus) {
      const wasIdle = IDLE.has(this.lastStatus);
      const wasLive = LIVE.has(this.lastStatus);
      if (status === "CRASHED") {
        toast.error("Miner Crashed", "The VerthashMiner process exited unexpectedly.", "miner-state");
      } else if (status === "STOPPED" && !wasIdle) {
        toast.neutral("Miner Stopped", "The VerthashMiner process has stopped.", "miner-state");
      } else if (status === "MINING" && this.lastStatus === "DISCONNECTED") {
        toast.success("Mining Resumed", "The miner is hashing again.", "miner-state");
      } else if (LIVE.has(status) && !wasLive) {
        toast.success("Miner Started", "The VerthashMiner process is running.", "miner-state");
      }
    }
    this.lastStatus = status;
  }

  render(snapshot) {
    this.serverNow = snapshot.now;
    this.capturedAt = Date.now();
    this.startedAt = snapshot.miner.running ? snapshot.startedAt : null;
    this.tz = snapshot.host.tz;
    this.accepted = snapshot.mining.accepted;
    this.tick();
    this.startClock();
    const display = presentSnapshot(snapshot, { now: this.serverNow, pendingStatus: this.pendingStatus });
    this.announce(display.status);
    text(this.els.host, display.host);
    this.applyChrome(display.status, !!this.pendingStatus);
    this.summary.hashrate.set({ value: display.hashrate });
    this.summary.accepted.set({ value: display.accepted });
    this.summary.ratio.set({ value: display.ratio });
    this.mining.rejected.set({ value: display.rejected });
    this.mining.difficulty.set({ value: display.difficulty });
    this.mining.lastAccepted.set({ value: display.lastAccepted });
    this.identity.set({ user: snapshot.miner.user, wallet: snapshot.miner.wallet, worker: snapshot.miner.worker });
    this.consoleView.render(snapshot.miner.logs, { count: snapshot.logCount, seq: snapshot.logSeq });
    if (snapshot.miner.lastError) {
      className(this.els.error, "errorbox show");
      text(this.els.error, `CRITICAL ERROR: ${snapshot.miner.lastError}`);
      if (snapshot.miner.lastError !== this.lastError) {
        this.lastError = snapshot.miner.lastError;
        const detail = stripLogPrefix(snapshot.miner.lastError);
        if (snapshot.mining.status === "DISCONNECTED") {
          toast.warn("Pool Disconnected", detail || "Lost connection to the mining pool.", "miner-error");
        } else {
          toast.error("Miner Error", detail || snapshot.miner.lastError, "miner-error");
        }
      }
    } else {
      className(this.els.error, "errorbox");
      this.lastError = null;
    }
    if (snapshot.gpuError && snapshot.gpuError !== this.lastGpuError) {
      this.lastGpuError = snapshot.gpuError;
      toast.error(
        "GPU Telemetry Unavailable",
        /ENOENT|not found|not recognized/i.test(snapshot.gpuError)
          ? "nvidia-smi could not be found. Check that NVIDIA drivers are installed and on your PATH."
          : snapshot.gpuError,
        "gpu-error",
      );
    } else if (!snapshot.gpuError) {
      this.lastGpuError = null;
    }
    gpuView.render(this.els.gpus, snapshot.gpu, snapshot.gpuError);
  }

  onStatusText(label, unreachable) {
    this.stopClock();
    this.pendingStatus = null;
    text(this.els.status, label);
    className(this.els.dot, "dot err");
    if (unreachable) text(this.els.host, "Host Unreachable");
    this.els.btnAction.disabled = true;
    this.els.btnRestart.disabled = true;
  }

  showAuth() {
    this.auth.input.value = "";
    this.auth.err.style.display = "none";
    this.modal.open(this.auth.wrap, { dismissable: false });
  }

  async login() {
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({ passphrase: this.auth.input.value }),
      });
      if (res.ok) {
        this.modal.close();
        toast.success("Login Successful", "Welcome to the VerthashMiner Dashboard.", "login-success");
        this.connection.restart();
        return;
      }
      if (res.status === 429) {
        this.auth.err.textContent = "Too many attempts. Please wait a moment and try again.";
        toast.warn("Too Many Requests", "Too many failed attempts. Please wait before trying again.", "rate-limit-login");
      } else {
        this.auth.err.textContent = "Invalid passphrase";
      }
    } catch (err) {
      console.error("[dashboard] login failed:", err.message);
      this.auth.err.textContent = "Invalid passphrase";
    }
    this.auth.err.style.display = "block";
  }

  async runAction(action) {
    const meta = ACTION_META[action];
    if (!meta || this.pendingStatus) return;
    this.pendingStatus = meta.status;
    this.applyChrome(this.pendingStatus, true);
    toast.info(meta.toast[0], meta.toast[1], `miner-${action}`);
    try {
      const res = await fetch(`/api/miner/${action}`, {
        method: "POST",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
      if (res.status === 401) {
        this.showAuth();
      } else if (!res.ok) {
        toast.dismiss(`miner-${action}`);
        if (res.status === 429) {
          let seconds = 5;
          try {
            const data = await res.clone().json();
            if (Number.isFinite(data.retryAfterSeconds)) seconds = data.retryAfterSeconds;
          } catch {}
          toast.warn("Too Many Requests", `Miner controls are rate limited. Please wait ${seconds} second${seconds === 1 ? "" : "s"} before trying again.`, "rate-limit-action");
        } else {
          toast.error("Action Failed", `The dashboard rejected the request (HTTP ${res.status}).`, "action-failed");
        }
      }
    } catch (err) {
      console.error("[dashboard] action failed:", err.message);
      toast.dismiss(`miner-${action}`);
      toast.error("Action Failed", "Could not reach the dashboard host. Please try again.", "action-failed");
    }
    this.pendingStatus = null;
  }

  promptAction(action, label) {
    if (this.pendingStatus) return;
    this.armedAction = action;
    text(this.confirm.title, label);
    text(this.confirm.desc, `Do you want to ${label.toLowerCase()} the miner process?`);
    className(this.confirm.yes, `modal-btn modal-btn-${action.toLowerCase()}`);
    text(this.confirm.yes, label);
    this.modal.open(this.confirm.wrap, {
      dismissable: true,
      onClose: () => { this.armedAction = null; },
    });
  }

  async softRefresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    this.els.refresh.disabled = true;
    this.els.refresh.setAttribute("aria-busy", "true");
    this.els.refresh.classList.add("spinning");
    let result;
    try {
      result = await this.connection.refresh();
    } catch (err) {
      console.error("[dashboard] refresh failed:", err.message);
      result = "failed";
    }
    if (result === "ok") {
      toast.info("Data Refreshed", "Pulled the latest stats from the dashboard API.", "soft-refresh");
    } else if (result === "limited") {
      toast.warn("Slow Down", "Refresh is rate limited. Please wait a moment and try again.", "soft-refresh");
    } else if (result === "failed") {
      toast.error("Refresh Failed", "Could not reach the dashboard API. Please try again.", "soft-refresh");
    }
    setTimeout(() => {
      this.refreshing = false;
      this.els.refresh.classList.remove("spinning");
      this.els.refresh.disabled = false;
      this.els.refresh.removeAttribute("aria-busy");
    }, 400);
  }

  bindEvents() {
    this.auth.submit.addEventListener("click", this.login.bind(this));
    this.auth.input.addEventListener("keydown", (e) => { if (e.key === "Enter") this.login(); });
    this.confirm.cancel.addEventListener("click", () => this.modal.close());
    this.confirm.yes.addEventListener("click", () => {
      const action = this.armedAction;
      this.modal.close();
      if (action) this.runAction(action);
    });
    this.els.btnAction.addEventListener("click", () => {
      const action = this.els.btnAction.textContent === "START" ? "start" : "stop";
      this.promptAction(action, action.toUpperCase());
    });
    this.els.btnRestart.addEventListener("click", () => this.promptAction("restart", "RESTART"));
    this.els.btnAutoScroll.addEventListener("click", () => {
      this.consoleView.autoScroll = !this.consoleView.autoScroll;
      this.onAutoScroll(this.consoleView.autoScroll);
    });
    this.els.refresh.addEventListener("click", this.softRefresh.bind(this));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.stopClock();
        this.connection.suspend();
      } else {
        this.startClock();
        if (this.connection.idle) this.connection.connect();
      }
    });
  }
}

new Dashboard();
