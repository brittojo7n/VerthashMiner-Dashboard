import "./perf.js";
import { el, text, className } from "./dom.js";
import { timestamp, uptime, stripLogPrefix, DASH } from "./format.js";
import {
  presentSnapshot,
  sharesPerMinute,
  dotClass,
  IDLE_STATUS as IDLE,
  LIVE_STATUS as LIVE
} from "./present.js";
import * as toast from "./toast.js";
import * as gpuView from "./gpu.js";
import { createConsole } from "./console.js";
import { createConnection } from "./connection.js";

const ACTION_META = {
  start:  { status: "STARTING",  label: "START", toast: ["Starting Miner", "Launching the VerthashMiner process."] },
  stop:   { status: "STOPPING",  label: "STOP",  toast: ["Stopping Miner", "Shutting down the VerthashMiner process."] },
  restart:{ status: "RESTARTING", label: "RESTART", toast: ["Restarting Miner", "Stopping and relaunching the VerthashMiner process."] }
};

const DOT_CLASS = {
  MINING: "dot ok", CONNECTED: "dot ok",
  WAITING: "dot warn", DISCONNECTED: "dot warn",
  STOPPED: "dot err", CRASHED: "dot err", ERROR: "dot err"
};

const els = {
  dot: el("dot"), status: el("status"), host: el("host"),
  btnAction: el("btnAction"), btnRestart: el("btnRestart"), error: el("error"),
  gpus: el("gpus"), localTime: el("localTime"),
  authModal: el("authModal"), authInput: el("authInput"), authError: el("authError"), authSubmit: el("authSubmit"),
  btnAutoScroll: el("btnAutoScroll"),
  uptime: el("uptime"), spm: el("sharesPerMinute"),
  hashrate: el("hashrate"), accepted: el("accepted"), ratio: el("ratio"),
  rejected: el("rejected"), difficulty: el("difficulty"),
  lastAccepted: el("lastAccepted"), wallet: el("walletAddress")
};

const consoleView = createConsole({
  terminal: el("terminal"),
  lines: el("logLines"),
  counter: el("logCount"),
  onAutoScrollChange: onAutoScroll
});

let serverNow = null, capturedAt = 0, startedAt = null, tz = null;
let accepted = 0, ticker = null;
let pendingStatus = null;
let lastError = null, lastGpuError = null, lastStatus = null;

function tick() {
  if (serverNow == null) return;
  const now = serverNow + (Date.now() - capturedAt);
  const elapsed = Math.max(0, now - startedAt);
  text(els.localTime, timestamp(now, tz));
  text(els.uptime, uptime(Math.floor(elapsed / 1000)));
  text(els.spm, sharesPerMinute(accepted, elapsed));
}
const startClock = () => { ticker ||= setInterval(tick, 1000); };
const stopClock = () => { clearInterval(ticker); ticker = null; };

function applyChrome(status, locked) {
  text(els.status, status);
  const idle = IDLE.has(status);
  const busy = locked || (!idle && !LIVE.has(status));
  className(els.dot, DOT_CLASS[status] || "dot err");
  text(els.btnAction, idle ? "START" : "STOP");
  className(els.btnAction, `c-btn ${idle ? "btn-start" : "btn-stop"}`);
  els.btnAction.disabled = busy;
  els.btnRestart.disabled = busy || idle;
}

function onAutoScroll(on) {
  className(els.btnAutoScroll, `c-btn${on ? " active" : ""}`);
  text(els.btnAutoScroll, `Auto-scroll: ${on ? "ON" : "OFF"}`);
}

function announce(status) {
  if (lastStatus !== null && status !== lastStatus) {
    const wasIdle = IDLE.has(lastStatus);
    const wasLive = LIVE.has(lastStatus);

    if (status === "CRASHED") {
      toast.error("Miner Crashed", "The VerthashMiner process exited unexpectedly.", "miner-state");
    } else if (status === "STOPPED" && !wasIdle) {
      toast.neutral("Miner Stopped", "The VerthashMiner process has stopped.", "miner-state");
    } else if (status === "MINING" && lastStatus === "DISCONNECTED") {
      toast.success("Mining Resumed", "The miner is hashing again.", "miner-state");
    } else if (LIVE.has(status) && !wasLive) {
      toast.success("Miner Started", "The VerthashMiner process is running.", "miner-state");
    }
  }
  lastStatus = status;
}

function render(snapshot) {
  serverNow = snapshot.now;
  capturedAt = Date.now();
  startedAt = snapshot.startedAt;
  tz = snapshot.host.tz;
  accepted = snapshot.mining.accepted;
  tick();
  startClock();

  const display = presentSnapshot(snapshot, { now: serverNow, pendingStatus });
  announce(display.status);

  text(els.host, display.host);
  applyChrome(display.status, !!pendingStatus);

  text(els.hashrate, display.hashrate);
  text(els.accepted, display.accepted);
  text(els.ratio, display.ratio);
  text(els.rejected, display.rejected);
  text(els.difficulty, display.difficulty);
  text(els.lastAccepted, display.lastAccepted);
  text(els.wallet, display.wallet);

  consoleView.render(snapshot.miner.logs, {
    count: snapshot.logCount,
    capacity: snapshot.logCapacity
  });

  if (snapshot.miner.lastError) {
    className(els.error, "errorbox show");
    text(els.error, `CRITICAL ERROR: ${snapshot.miner.lastError}`);
    if (snapshot.miner.lastError !== lastError) {
      lastError = snapshot.miner.lastError;
      const detail = stripLogPrefix(snapshot.miner.lastError);
      if (snapshot.mining.status === "DISCONNECTED") {
        toast.warn("Pool Disconnected", detail || "Lost connection to the mining pool.", "miner-error");
      } else {
        toast.error("Miner Error", detail || snapshot.miner.lastError, "miner-error");
      }
    }
  } else {
    className(els.error, "errorbox");
    lastError = null;
  }

  if (snapshot.gpuError && snapshot.gpuError !== lastGpuError) {
    lastGpuError = snapshot.gpuError;
    toast.error(
      "GPU Telemetry Unavailable",
      /ENOENT|not found|not recognized/i.test(snapshot.gpuError)
        ? "nvidia-smi could not be found. Check that NVIDIA drivers are installed and on your PATH."
        : snapshot.gpuError,
      "gpu-error"
    );
  } else if (!snapshot.gpuError) {
    lastGpuError = null;
  }

  gpuView.render(els.gpus, snapshot.gpu, snapshot.gpuError);
}

const connection = createConnection({
  onSnapshot: render,
  onUnauthorized: showAuth,
  onLive: () => els.authModal.classList.remove("show"),
  onCountdown: message => text(els.host, message),
  onStatusText: (label, unreachable) => {
    stopClock();
    pendingStatus = null;
    text(els.status, label);
    className(els.dot, "dot err");
    if (unreachable) text(els.host, "Host Unreachable");
    els.btnAction.disabled = true;
    els.btnRestart.disabled = true;
  }
});

function showAuth() {
  els.authModal.classList.add("show");
  els.authInput.value = "";
  els.authInput.focus();
}

async function login() {
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify({ passphrase: els.authInput.value })
    });
    if (res.ok) {
      els.authModal.classList.remove("show");
      els.authError.style.display = "none";
      toast.success("Login Successful", "Welcome to the VerthashMiner Dashboard.", "login-success");
      connection.restart();
      return;
    }
    if (res.status === 429) {
      els.authError.textContent = "Too many attempts. Please wait a moment and try again.";
      toast.warn("Too Many Requests", "Too many failed attempts. Please wait before trying again.", "rate-limit-login");
    } else {
      els.authError.textContent = "Invalid passphrase";
    }
  } catch {
    els.authError.textContent = "Invalid passphrase";
  }
  els.authError.style.display = "block";
}

async function runAction(action) {
  const meta = ACTION_META[action];
  if (!meta || pendingStatus) return;
  pendingStatus = meta.status;
  applyChrome(pendingStatus, true);

  toast.info(meta.toast[0], meta.toast[1], `miner-${action}`);

  try {
    const res = await fetch(`/api/miner/${action}`, {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest" }
    });
    if (res.status === 401) {
      showAuth();
    } else if (!res.ok) {
      toast.dismiss(`miner-${action}`);
      if (res.status === 429) {
        let seconds = 5;
        try {
          const data = await res.clone().json();
          if (Number.isFinite(data.retryAfterSeconds)) seconds = data.retryAfterSeconds;
        } catch { }
        toast.warn("Too Many Requests",
          `Miner controls are rate limited. Please wait ${seconds} second${seconds === 1 ? "" : "s"} before trying again.`,
          "rate-limit-action");
      } else {
        toast.error("Action Failed", `The dashboard rejected the request (HTTP ${res.status}).`, "action-failed");
      }
    }
  } catch {
    toast.dismiss(`miner-${action}`);
    toast.error("Action Failed", "Could not reach the dashboard host. Please try again.", "action-failed");
  }
  pendingStatus = null;
}

const confirmModal = el("confirmModal");
const confirmYes = el("confirmYes");
let armedAction = null;

function promptAction(action, label) {
  if (pendingStatus) return;
  armedAction = action;
  text(el("confirmTitle"), label);
  text(el("confirmDesc"), `Do you want to ${label.toLowerCase()} the miner process?`);
  className(confirmYes, `auth-btn auth-btn-${action.toLowerCase()}`);
  text(confirmYes, label);
  confirmModal.classList.add("show");
}
const closeConfirm = () => { confirmModal.classList.remove("show"); armedAction = null; };

els.authSubmit.addEventListener("click", login);
els.authInput.addEventListener("keydown", e => { if (e.key === "Enter") login(); });
el("confirmCancel").addEventListener("click", closeConfirm);
confirmYes.addEventListener("click", () => {
  const action = armedAction;
  closeConfirm();
  if (action) runAction(action);
});
els.btnAction.addEventListener("click", () => promptAction(els.btnAction.textContent === "START" ? "start" : "stop", els.btnAction.textContent === "START" ? "START" : "STOP"));
els.btnRestart.addEventListener("click", () => promptAction("restart", "RESTART"));
els.btnAutoScroll.addEventListener("click", () => {
  consoleView.autoScroll = !consoleView.autoScroll;
  onAutoScroll(consoleView.autoScroll);
});
el("btnCopyLogs").addEventListener("click", async event => {
  const rows = el("logLines").querySelectorAll(".log-msg");
  if (!rows.length) return;
  const body = Array.from(rows, node => `> ${node.textContent}`).join("\n");
  try {
    await navigator.clipboard.writeText(body);
    const button = event.currentTarget;
    const original = button.textContent;
    button.textContent = "Copied!";
    setTimeout(() => { button.textContent = original; }, 1200);
  } catch { }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopClock();
    connection.suspend();
  } else {
    startClock();
    if (connection.idle) connection.connect();
  }
});

connection.connect();
