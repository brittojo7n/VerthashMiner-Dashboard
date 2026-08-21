import * as toast from "./toast.js";
const REFRESH_WINDOW_MS = 2000;
const BASE_DELAY_MS = 500;
const PENALTY_DELAY_MS = 3000;
const PACE_STEP_MS = 850;
const BACKOFF_START_MS = 2000;
const BACKOFF_MAX_MS = 30000;
const LAST_REFRESH_KEY = "vmd:lastRefreshAt";
const RAPID_REFRESH_KEY = "vmd:rapidRefresh";
function readStore(key) { try { return Number(sessionStorage.getItem(key)) || 0; } catch { return 0; } }
function writeStore(key, value) { try { sessionStorage.setItem(key, String(value)); } catch { } }
function getPaceDelay(now) {
  const previous = readStore(LAST_REFRESH_KEY);
  const elapsed = previous ? now - previous : Infinity;
  writeStore(LAST_REFRESH_KEY, now);
  if (elapsed >= REFRESH_WINDOW_MS) { writeStore(RAPID_REFRESH_KEY, 1); return BASE_DELAY_MS; }
  const rapid = readStore(RAPID_REFRESH_KEY) + 1;
  writeStore(RAPID_REFRESH_KEY, rapid);
  return Math.min(PENALTY_DELAY_MS, BASE_DELAY_MS + (rapid - 1) * PACE_STEP_MS);
}
async function retryDelay(response) {
  try { const data = await response.clone().json(); if (Number.isFinite(data?.retryAfterMs)) return data.retryAfterMs; } catch { }
  const header = Number.parseInt(response.headers.get("Retry-After") || "", 10);
  return Number.isFinite(header) && header > 0 ? header * 1000 : 5000;
}
export function createConnection({ onSnapshot, onUnauthorized, onStatusText, onCountdown, onLive }) {
  let source = null;
  let retryTimer = null;
  let countdownTimer = null;
  let backoff = 0;
  let connected = false;
  let paceOnce = true;
  let lastFrameAt = 0;
  let lastSeq = -1;
  const STREAM_STALE_MS = 15000;
  const clearTimers = () => { clearTimeout(retryTimer); retryTimer = null; clearInterval(countdownTimer); countdownTimer = null; };
  const schedule = (delay, label) => {
    clearTimers();
    if (label) {
      const target = Date.now() + delay;
      const paint = () => { const left = Math.max(0, Math.ceil((target - Date.now()) / 1000)); onCountdown?.(left > 0 ? `${label} in ${left}s\u2026` : `${label}\u2026`); };
      paint();
      countdownTimer = setInterval(paint, 500);
    }
    retryTimer = setTimeout(connect, delay);
  };
  const nextBackoff = () => (backoff = Math.min(BACKOFF_MAX_MS, backoff ? backoff * 2 : BACKOFF_START_MS));
  function rateLimited(wait) { onStatusText?.("CONNECTING"); schedule(wait, "Resuming"); }
  async function probeStatus() {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (res.status === 401) return { unauthorized: true };
      if (res.status === 429) return { limited: await retryDelay(res) };
      if (res.ok) {
        const snapshot = await res.json().catch(() => null);
        return { ok: true, snapshot, streamWait: Number(snapshot?.streamRetryAfterMs) || 0 };
      }
      return {};
    } catch {
      return { unreachable: true };
    }
  }
  function openStream() {
    source?.close();
    source = new EventSource("/events");
    lastFrameAt = Date.now();
    source.addEventListener("stats", event => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      lastFrameAt = Date.now();
      if (Number.isFinite(payload.logSeq)) lastSeq = payload.logSeq;
      if (!connected) { connected = true; backoff = 0; clearTimers(); toast.dismiss("offline"); onLive?.(); }
      onSnapshot(payload);
    });
    source.addEventListener("rejected", () => {
      connected = false;
      source?.close();
      source = null;
      toast.warn("Viewer Limit Reached", "This dashboard already has the maximum number of live viewers. Retrying in 30 seconds.", "sse-limit");
      onStatusText?.("VIEWER LIMIT");
      schedule(30000, "Retrying");
    });
    source.onerror = async () => {
      const wasConnected = connected;
      connected = false;
      if (source?.readyState !== EventSource.CLOSED) { onStatusText?.("RECONNECTING"); return; }
      source.close();
      source = null;
      const r = await probeStatus();
      if (r.unauthorized) return onUnauthorized();
      if (r.limited) return rateLimited(r.limited);
      if (r.snapshot) onSnapshot(r.snapshot);
      if (r.streamWait > 0) return rateLimited(r.streamWait);
      onStatusText?.("OFFLINE", !wasConnected);
      toast.error("Connection Lost", "Lost contact with the dashboard host. Retrying automatically.", "offline");
      schedule(nextBackoff() + Math.floor(Math.random() * 400), "Reconnecting");
    };
  }
  async function connect() {
    clearTimers();
    if (document.hidden) return;
    if (paceOnce) {
      paceOnce = false;
      const now = Date.now();
      const paceDelay = getPaceDelay(now);
      if (paceDelay > 0) { onStatusText?.("CONNECTING"); schedule(paceDelay, null); return; }
    }
    const r = await probeStatus();
    if (r.unauthorized) return onUnauthorized();
    if (r.limited) return rateLimited(r.limited);
    if (r.snapshot) {
      try { onSnapshot(r.snapshot); } catch (err) { console.error("[dashboard] render failed", err); }
    }
    if (r.streamWait > 0) return rateLimited(r.streamWait);
    if (r.ok) return openStream();
    onStatusText?.("OFFLINE", r.unreachable);
    schedule(nextBackoff(), "Retrying");
  }
  return {
    connect,
    restart() { backoff = 0; connect(); },
    async refresh() {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (res.status === 401) { onUnauthorized?.(); return "unauthorized"; }
        if (res.status === 429) return "limited";
        if (!res.ok) return "failed";
        const snapshot = await res.json().catch(() => null);
        if (!snapshot) return "failed";
        onSnapshot(snapshot);
        const dead = !source || source.readyState === EventSource.CLOSED;
        const behind = Number.isFinite(snapshot.logSeq) && lastSeq >= 0 && snapshot.logSeq - lastSeq >= 2;
        const silent = lastFrameAt > 0 && Date.now() - lastFrameAt > STREAM_STALE_MS;
        if (dead || behind || silent) { connected = false; clearTimers(); openStream(); }
        return "ok";
      } catch { return "failed"; }
    },
    suspend() { clearTimers(); connected = false; source?.close(); source = null; },
    get idle() { return !source || source.readyState === EventSource.CLOSED; }
  };
}
