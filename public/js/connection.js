import * as toast from "./toast.js";

/**
 * Dashboard connection manager.
 *
 * Invariant: every response path ends in either a live stream or a scheduled
 * retry. A status that falls through without doing one of those is what
 * previously left the dashboard blank after an aggressive-refresh 429.
 */

const MIN_REFRESH_GAP_MS = 1500; // Pace loads so bursts cannot overload the API.
const BACKOFF_START_MS = 2000;
const BACKOFF_MAX_MS = 30000;
const RETRY_GRACE_MS = 250;      // Land just after the server window rolls over.
const LAST_ATTEMPT_KEY = "vmd:lastConnectAt";

/** Persisted across reloads so rapid F5 presses are paced against each other. */
function lastAttempt() {
  try { return Number(sessionStorage.getItem(LAST_ATTEMPT_KEY)) || 0; }
  catch { return 0; }
}
function markAttempt(ts) {
  try { sessionStorage.setItem(LAST_ATTEMPT_KEY, String(ts)); } catch { /* private mode */ }
}

/** Prefer the JSON body's precise value, fall back to the Retry-After header. */
async function retryDelay(response) {
  try {
    const data = await response.clone().json();
    if (Number.isFinite(data?.retryAfterMs)) return data.retryAfterMs;
  } catch { /* not JSON */ }
  const header = Number.parseInt(response.headers.get("Retry-After") || "", 10);
  return Number.isFinite(header) && header > 0 ? header * 1000 : 5000;
}

export function createConnection({ onSnapshot, onUnauthorized, onStatusText, onCountdown, onLive }) {
  let source = null;
  let retryTimer = null;
  let countdownTimer = null;
  let backoff = 0;
  let connected = false;

  const clearTimers = () => {
    clearTimeout(retryTimer); retryTimer = null;
    clearInterval(countdownTimer); countdownTimer = null;
  };

  const schedule = (delay, label) => {
    clearTimers();
    if (label) {
      const target = Date.now() + delay;
      const paint = () => {
        const left = Math.max(0, Math.ceil((target - Date.now()) / 1000));
        onCountdown?.(left > 0 ? `${label} in ${left}s\u2026` : `${label}\u2026`);
      };
      paint();
      countdownTimer = setInterval(paint, 500);
    }
    retryTimer = setTimeout(connect, delay);
  };

  const nextBackoff = () => (backoff = Math.min(BACKOFF_MAX_MS, backoff ? backoff * 2 : BACKOFF_START_MS));

  async function handleRateLimit(response) {
    const wait = await retryDelay(response);
    const seconds = Math.max(1, Math.ceil(wait / 1000));
    toast.warn(
      "Too Many Requests",
      `You're refreshing too quickly. The dashboard will resume automatically in ${seconds} second${seconds === 1 ? "" : "s"}.`,
      "rate-limit"
    );
    onStatusText?.("RATE LIMITED");
    schedule(wait + RETRY_GRACE_MS, "Resuming");
  }

  function openStream() {
    source?.close();
    source = new EventSource("/events");

    source.addEventListener("stats", event => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (!connected) {
        connected = true;
        backoff = 0;
        clearTimers();
        toast.dismiss("rate-limit");
        toast.dismiss("offline");
        onLive?.();
      }
      onSnapshot(payload);
    });

    source.onerror = async () => {
      const wasConnected = connected;
      connected = false;

      // EventSource cannot expose the response body, so probe /api/status to
      // learn why the stream would not open.
      if (source?.readyState !== EventSource.CLOSED) {
        onStatusText?.("RECONNECTING");
        return;
      }
      source.close();
      source = null;

      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (res.status === 401) return onUnauthorized();
        if (res.status === 429) return handleRateLimit(res);
      } catch { /* offline; fall through to backoff */ }

      onStatusText?.("OFFLINE", !wasConnected);
      toast.error("Connection Lost", "Lost contact with the dashboard host. Retrying automatically.", "offline");
      schedule(nextBackoff() + Math.floor(Math.random() * 400), "Reconnecting");
    };
  }

  async function connect() {
    clearTimers();
    if (document.hidden) return;

    const since = Date.now() - lastAttempt();
    if (since < MIN_REFRESH_GAP_MS) {
      onStatusText?.("CONNECTING");
      schedule(MIN_REFRESH_GAP_MS - since);
      return;
    }
    markAttempt(Date.now());

    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (res.status === 401) return onUnauthorized();
      if (res.status === 429) return handleRateLimit(res);

      if (res.ok) {
        // Paint from the snapshot immediately so values appear before the
        // first SSE frame arrives. A render fault must not abort the stream,
        // but it is reported rather than silently swallowed.
        try { onSnapshot(await res.json()); }
        catch (err) { console.error("[dashboard] render failed", err); }
        openStream();
        return;
      }

      onStatusText?.("OFFLINE");
      schedule(nextBackoff(), "Retrying");
    } catch {
      onStatusText?.("OFFLINE", true);
      schedule(nextBackoff(), "Retrying");
    }
  }

  return {
    connect,
    restart() { backoff = 0; connect(); },
    suspend() {
      clearTimers();
      connected = false;
      source?.close();
      source = null;
    },
    get idle() { return !source || source.readyState === EventSource.CLOSED; }
  };
}
