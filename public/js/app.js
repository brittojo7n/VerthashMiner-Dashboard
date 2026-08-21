import "./perf.js";
import { el, text, className, make } from "./dom.js";
import { createModal } from "./modal.js";
import { presentSnapshot, sharesPerMinute, dotClass, timestamp, uptime, stripLogPrefix, DASH, IDLE_STATUS as IDLE, LIVE_STATUS as LIVE } from "./present.js";
import * as toast from "./toast.js";
import * as gpuView from "./gpu.js";
import { createConsole } from "./console.js";
import { createConnection } from "./connection.js";
const ACTION_META = {
  start: { status: "STARTING", label: "START", toast: ["Starting Miner", "Launching the VerthashMiner process."] },
  stop: { status: "STOPPING", label: "STOP", toast: ["Stopping Miner", "Shutting down the VerthashMiner process."] },
  restart: { status: "RESTARTING", label: "RESTART", toast: ["Restarting Miner", "Stopping and relaunching the VerthashMiner process."] }
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

function initDashboard() {
  const els = {
    dot: el("dot"), status: el("status"), host: el("host"),
    btnAction: el("btnAction"), btnRestart: el("btnRestart"), error: el("error"),
    gpus: el("gpus"), localTime: el("localTime"),
    btnAutoScroll: el("btnAutoScroll"),
    uptime: el("uptime"), spm: el("sharesPerMinute"),
    hashrate: el("hashrate"), accepted: el("accepted"), ratio: el("ratio"),
    rejected: el("rejected"), difficulty: el("difficulty"),
    lastAccepted: el("lastAccepted"), wallet: el("walletAddress"),
    refresh: el("btnRefresh")
  };
  const modal = createModal();
  const auth = buildAuthContent();
  const confirm = buildConfirmContent();
  const consoleView = createConsole({ terminal: el("terminal"), lines: el("logLines"), counter: el("logCount"), onAutoScrollChange: onAutoScroll });
  let serverNow = null, capturedAt = 0, startedAt = null, tz = null;
  let accepted = 0, ticker = null;
  let pendingStatus = null;
  let lastError = null, lastGpuError = null, lastStatus = null;
  function tick() {
    if (serverNow == null) return;
    const now = serverNow + (Date.now() - capturedAt);
    text(els.localTime, timestamp(now, tz));
    if (startedAt) {
      const elapsed = Math.max(0, now - startedAt);
      text(els.uptime, uptime(Math.floor(elapsed / 1000)));
      text(els.spm, sharesPerMinute(accepted, elapsed));
    } else { text(els.uptime, DASH); text(els.spm, DASH); }
  }
  const startClock = () => { ticker ||= setInterval(tick, 1000); };
  const stopClock = () => { clearInterval(ticker); ticker = null; };
  function applyChrome(status, locked) {
    text(els.status, status);
    const idle = IDLE.has(status);
    const busy = locked || (!idle && !LIVE.has(status));
    className(els.dot, dotClass(status));
    text(els.btnAction, idle ? "START" : "STOP");
    className(els.btnAction, `c-btn ${idle ? "btn-start" : "btn-stop"}`);
    els.btnAction.disabled = busy;
    els.btnRestart.disabled = busy || idle;
  }
  function onAutoScroll(on) { className(els.btnAutoScroll, `c-btn${on ? " active" : ""}`); text(els.btnAutoScroll, `Auto-scroll: ${on ? "ON" : "OFF"}`); }
  function announce(status) {
    if (lastStatus !== null && status !== lastStatus) {
      const wasIdle = IDLE.has(lastStatus);
      const wasLive = LIVE.has(lastStatus);
      if (status === "CRASHED") toast.error("Miner Crashed", "The VerthashMiner process exited unexpectedly.", "miner-state");
      else if (status === "STOPPED" && !wasIdle) toast.neutral("Miner Stopped", "The VerthashMiner process has stopped.", "miner-state");
      else if (status === "MINING" && lastStatus === "DISCONNECTED") toast.success("Mining Resumed", "The miner is hashing again.", "miner-state");
      else if (LIVE.has(status) && !wasLive) toast.success("Miner Started", "The VerthashMiner process is running.", "miner-state");
    }
    lastStatus = status;
  }
  function render(snapshot) {
    serverNow = snapshot.now;
    capturedAt = Date.now();
    startedAt = snapshot.miner.running ? snapshot.startedAt : null;
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
    consoleView.render(snapshot.miner.logs, { count: snapshot.logCount, seq: snapshot.logSeq });
    if (snapshot.miner.lastError) {
      className(els.error, "errorbox show");
      text(els.error, `CRITICAL ERROR: ${snapshot.miner.lastError}`);
      if (snapshot.miner.lastError !== lastError) {
        lastError = snapshot.miner.lastError;
        const detail = stripLogPrefix(snapshot.miner.lastError);
        if (snapshot.mining.status === "DISCONNECTED") toast.warn("Pool Disconnected", detail || "Lost connection to the mining pool.", "miner-error");
        else toast.error("Miner Error", detail || snapshot.miner.lastError, "miner-error");
      }
    } else { className(els.error, "errorbox"); lastError = null; }
    if (snapshot.gpuError && snapshot.gpuError !== lastGpuError) {
      lastGpuError = snapshot.gpuError;
      toast.error("GPU Telemetry Unavailable", /ENOENT|not found|not recognized/i.test(snapshot.gpuError) ? "nvidia-smi could not be found. Check that NVIDIA drivers are installed and on your PATH." : snapshot.gpuError, "gpu-error");
    } else if (!snapshot.gpuError) { lastGpuError = null; }
    gpuView.render(els.gpus, snapshot.gpu, snapshot.gpuError);
  }
  const connection = createConnection({
    onSnapshot: render,
    onUnauthorized: showAuth,
    onLive: () => modal.close(),
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
    auth.input.value = "";
    auth.err.style.display = "none";
    modal.open(auth.wrap, { dismissable: false });
  }
  async function login() {
    try {
      const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" }, body: JSON.stringify({ passphrase: auth.input.value }) });
      if (res.ok) {
        modal.close();
        toast.success("Login Successful", "Welcome to the VerthashMiner Dashboard.", "login-success");
        connection.restart();
        return;
      }
      if (res.status === 429) { auth.err.textContent = "Too many attempts. Please wait a moment and try again."; toast.warn("Too Many Requests", "Too many failed attempts. Please wait before trying again.", "rate-limit-login"); }
      else auth.err.textContent = "Invalid passphrase";
    } catch { auth.err.textContent = "Invalid passphrase"; }
    auth.err.style.display = "block";
  }
  async function runAction(action) {
    const meta = ACTION_META[action];
    if (!meta || pendingStatus) return;
    pendingStatus = meta.status;
    applyChrome(pendingStatus, true);
    toast.info(meta.toast[0], meta.toast[1], `miner-${action}`);
    try {
      const res = await fetch(`/api/miner/${action}`, { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" } });
      if (res.status === 401) showAuth();
      else if (!res.ok) {
        toast.dismiss(`miner-${action}`);
        if (res.status === 429) {
          let seconds = 5;
          try { const data = await res.clone().json(); if (Number.isFinite(data.retryAfterSeconds)) seconds = data.retryAfterSeconds; } catch { }
          toast.warn("Too Many Requests", `Miner controls are rate limited. Please wait ${seconds} second${seconds === 1 ? "" : "s"} before trying again.`, "rate-limit-action");
        } else toast.error("Action Failed", `The dashboard rejected the request (HTTP ${res.status}).`, "action-failed");
      }
    } catch { toast.dismiss(`miner-${action}`); toast.error("Action Failed", "Could not reach the dashboard host. Please try again.", "action-failed"); }
    pendingStatus = null;
  }
  let armedAction = null;
  function promptAction(action, label) {
    if (pendingStatus) return;
    armedAction = action;
    text(confirm.title, label);
    text(confirm.desc, `Do you want to ${label.toLowerCase()} the miner process?`);
    className(confirm.yes, `modal-btn modal-btn-${action.toLowerCase()}`);
    text(confirm.yes, label);
    modal.open(confirm.wrap, { dismissable: true, onClose: () => { armedAction = null; } });
  }
  auth.submit.addEventListener("click", login);
  auth.input.addEventListener("keydown", e => { if (e.key === "Enter") login(); });
  confirm.cancel.addEventListener("click", () => modal.close());
  confirm.yes.addEventListener("click", () => { const action = armedAction; modal.close(); if (action) runAction(action); });
  const btnActionKind = () => els.btnAction.textContent === "START" ? "start" : "stop";
  els.btnAction.addEventListener("click", () => { const action = btnActionKind(); promptAction(action, action.toUpperCase()); });
  els.btnRestart.addEventListener("click", () => promptAction("restart", "RESTART"));
  els.btnAutoScroll.addEventListener("click", () => { consoleView.autoScroll = !consoleView.autoScroll; onAutoScroll(consoleView.autoScroll); });
  const REFRESH_SETTLE_MS = 400;
  const REFRESH_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
  let refreshing = false;

  function refreshRotationDeg(svg) {
    const t = getComputedStyle(svg).transform;
    if (!t || t === "none") return 0;
    const m = /matrix\(([^)]+)\)/.exec(t);
    if (!m) return 0;
    const p = m[1].split(",").map(Number);
    const deg = Math.atan2(p[1], p[0]) * (180 / Math.PI);
    return ((deg % 360) + 360) % 360;
  }

  function finishRefresh() {
    if (!refreshing) return;
    refreshing = false;
    const svg = els.refresh.querySelector("svg");
    if (svg) { svg.style.transition = ""; svg.style.transform = ""; }
    els.refresh.classList.remove("spinning");
    els.refresh.disabled = false;
    els.refresh.removeAttribute("aria-busy");
  }

  function settleRefresh() {
    const svg = els.refresh.querySelector("svg");
    const reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!svg || reduceMotion) { finishRefresh(); return; }
    const angle = refreshRotationDeg(svg);
    if (angle < 0.5) { finishRefresh(); return; }
    els.refresh.classList.remove("spinning");
    svg.style.transition = "none";
    svg.style.transform = `rotate(${angle}deg)`;
    void getComputedStyle(svg).transform;
    svg.style.transition = `transform ${REFRESH_SETTLE_MS}ms ${REFRESH_EASE}`;
    svg.style.transform = "rotate(0deg)";
    const onEnd = e => {
      if (e.propertyName !== "transform") return;
      svg.removeEventListener("transitionend", onEnd);
      finishRefresh();
    };
    svg.addEventListener("transitionend", onEnd);
  }

  async function softRefresh() {
    if (refreshing) return;
    refreshing = true;
    els.refresh.disabled = true;
    els.refresh.setAttribute("aria-busy", "true");
    els.refresh.classList.add("spinning");
    let result;
    try { result = await connection.refresh(); }
    catch { result = "failed"; }
    if (result === "ok") toast.info("Data Refreshed", "Pulled the latest stats from the dashboard API.", "soft-refresh");
    else if (result === "limited") toast.warn("Slow Down", "Refresh is rate limited. Please wait a moment and try again.", "soft-refresh");
    else if (result === "failed") toast.error("Refresh Failed", "Could not reach the dashboard API. Please try again.", "soft-refresh");
    settleRefresh();
  }
  els.refresh.addEventListener("click", softRefresh);
  document.addEventListener("visibilitychange", () => { if (document.hidden) { stopClock(); connection.suspend(); } else { startClock(); if (connection.idle) connection.connect(); } });
  gpuView.render(els.gpus, [], "");
  connection.connect();
}
initDashboard();
