import { el, text, className } from "./dom.js";
import { num, uptime, timestamp, stripLogPrefix, DASH } from "./format.js";
import * as toast from "./toast.js";
import * as gpuView from "./gpu.js";
import { createConsole } from "./console.js";
import { createConnection } from "./connection.js";

const IDLE = new Set(["STOPPED", "CRASHED", "ERROR"]);

const LIVE = new Set(["MINING", "CONNECTED", "WAITING", "DISCONNECTED"]);
const ACTION_STATUS = { start: "STARTING", stop: "STOPPING", restart: "RESTARTING" };
const ACTION_TOAST = {
  start: ["Starting Miner", "Launching the VerthashMiner process."],
  stop: ["Stopping Miner", "Shutting down the VerthashMiner process."],
  restart: ["Restarting Miner", "Stopping and relaunching the VerthashMiner process."]
};

const dot = el("dot");
const statusEl = el("status");
const hostEl = el("host");
const btnAction = el("btnAction");
const btnRestart = el("btnRestart");
const errorEl = el("error");
const gpusBox = el("gpus");
const localTimeEl = el("localTime");
const authModal = el("authModal");
const authInput = el("authInput");
const authError = el("authError");
const btnAutoScroll = el("btnAutoScroll");

const view = createConsole({
  terminal: el("terminal"),
  lines: el("logLines"),
  counter: el("logCount"),
  onAutoScrollChange: paintAutoScroll
});

let serverNow = null, capturedAt = 0, startedAt = null, tz = null;
let accepted = 0, ticker = null;

function tick() {
  if (serverNow == null) return;
  const now = serverNow + (Date.now() - capturedAt);
  text(localTimeEl, timestamp(now, tz));
  text(el("uptime"), uptime(Math.floor((now - startedAt) / 1000)));
  const minutes = (now - startedAt) / 60000;
  const spm = minutes > 0 ? accepted / minutes : accepted;
  text(el("sharesPerMinute"), spm > 0 ? num(spm, 3) : DASH);
}
const startClock = () => { ticker ||= setInterval(tick, 1000); };
const stopClock = () => { clearInterval(ticker); ticker = null; };

let pendingStatus = null;
let lastError = null, lastGpuError = null, lastStatus = null;

function applyChrome(status, locked) {
  text(statusEl, status);
  const idle = IDLE.has(status);
  const busy = locked || (!idle && !LIVE.has(status));
  className(dot, `dot ${idle ? "err" : status === "MINING" || status === "CONNECTED" ? "ok" : "warn"}`);
  text(btnAction, idle ? "START" : "STOP");
  className(btnAction, `c-btn ${idle ? "btn-start" : "btn-stop"}`);
  btnAction.disabled = busy;
  btnRestart.disabled = busy || idle;
}

function paintAutoScroll(on) {
  className(btnAutoScroll, `c-btn${on ? " active" : ""}`);
  text(btnAutoScroll, `Auto-scroll: ${on ? "ON" : "OFF"}`);
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

  text(hostEl, `Host: ${snapshot.host.hostname}`);
  announce(snapshot.mining.status);

  const status = pendingStatus
    || (!snapshot.miner.running && LIVE.has(snapshot.mining.status) ? "STOPPED" : snapshot.mining.status);
  applyChrome(status, !!pendingStatus);

  const m = snapshot.mining;
  text(el("hashrate"), num(m.hashrateKHs, 2));
  text(el("accepted"), m.submitted === 0 ? DASH : `${m.accepted} / ${m.submitted}`);
  text(el("ratio"), snapshot.acceptedRatio == null ? DASH : `${num(snapshot.acceptedRatio, 1)}%`);
  text(el("rejected"), m.rejected);
  text(el("difficulty"), m.difficulty ?? DASH);
  text(el("lastAccepted"), m.lastAcceptedAt ? timestamp(m.lastAcceptedAt) : DASH);
  text(el("walletAddress"), snapshot.miner.wallet || DASH);

  view.render(snapshot.miner.logs);

  if (snapshot.miner.lastError) {
    className(errorEl, "errorbox show");
    text(errorEl, `CRITICAL ERROR: ${snapshot.miner.lastError}`);
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
    className(errorEl, "errorbox");
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

  gpuView.render(gpusBox, snapshot.gpu, snapshot.gpuError);
}

const connection = createConnection({
  onSnapshot: render,
  onUnauthorized: showAuth,
  onLive: () => { authModal.classList.remove("show"); },
  onCountdown: message => text(hostEl, message),
  onStatusText: (label, unreachable) => {
    stopClock();
    pendingStatus = null;
    text(statusEl, label);
    className(dot, "dot err");
    if (unreachable) text(hostEl, "Host Unreachable");
    btnAction.disabled = true;
    btnRestart.disabled = true;
  }
});

function showAuth() {
  authModal.classList.add("show");
  authInput.value = "";
  authInput.focus();
}

async function login() {
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify({ passphrase: authInput.value })
    });
    if (res.ok) {
      authModal.classList.remove("show");
      authError.style.display = "none";
      toast.success("Login Successful", "Welcome to the VerthashMiner Dashboard.", "login-success");
      connection.restart();
      return;
    }
    if (res.status === 429) {
      authError.textContent = "Too many attempts. Please wait a moment and try again.";
      toast.warn("Too Many Requests", "Too many failed attempts. Please wait before trying again.", "rate-limit-login");
    } else {
      authError.textContent = "Invalid passphrase";
    }
  } catch {
    authError.textContent = "Invalid passphrase";
  }
  authError.style.display = "block";
}

async function runAction(action) {
  const next = ACTION_STATUS[action];
  if (!next || pendingStatus) return;
  pendingStatus = next;
  applyChrome(next, true);

  const [title, message] = ACTION_TOAST[action];
  toast.info(title, message, `miner-${action}`);

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
        } catch {  }
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
  className(confirmYes, `auth-btn auth-btn-${action}`);
  text(confirmYes, label);
  confirmModal.classList.add("show");
}
const closeConfirm = () => { confirmModal.classList.remove("show"); armedAction = null; };

el("authSubmit").addEventListener("click", login);
authInput.addEventListener("keydown", e => { if (e.key === "Enter") login(); });
el("confirmCancel").addEventListener("click", closeConfirm);
confirmYes.addEventListener("click", () => {
  const action = armedAction;
  closeConfirm();
  if (action) runAction(action);
});
btnAction.addEventListener("click", () =>
  promptAction(btnAction.textContent === "START" ? "start" : "stop",
    btnAction.textContent === "START" ? "START" : "STOP"));
btnRestart.addEventListener("click", () => promptAction("restart", "RESTART"));
btnAutoScroll.addEventListener("click", () => {
  view.autoScroll = !view.autoScroll;
  paintAutoScroll(view.autoScroll);
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
  } catch {  }
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
