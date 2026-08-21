const hasDom = typeof document !== "undefined" && typeof document.documentElement === "object";
const root = hasDom ? document.documentElement : null;
const media = query => (typeof matchMedia === "function" ? matchMedia(query).matches : false);

const FRAME_BUDGET_MS = 17;
const PROBE_FRAMES = 42;
const PROBE_SKIP = 4;
const PROBE_DELAY_MS = 600;
const PROBE_P95_MS = 25;
const GOVERNOR_WINDOW_MS = 1500;
const GOVERNOR_STRIKES = 2;
const GOVERNOR_P95_MS = 34;
const LOCK_KEY = "vmd:fxLock";

function frameStats(deltas) {
  if (!deltas.length) return null;
  const sorted = deltas.slice().sort((a, b) => a - b);
  return {
    median: sorted[sorted.length >> 1],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  };
}

function createPerfGate(env) {
  const { root, media, raf, visible, storage, onChange, onVisible, delay } = env;
  const self = { mode: "lite", locked: false, reason: "boot", started: false };

  function setMode(mode, reason) {
    self.reason = reason;
    const changed = self.mode !== mode;
    self.mode = mode;
    if (root && root.classList) {
      if (mode === "fx") root.classList.add("fx");
      else root.classList.remove("fx");
    }
    if (changed && typeof onChange === "function") onChange(mode, reason);
  }

  function lockLite(reason) {
    self.locked = true;
    stopGovernor();
    setMode("lite", reason);
  }

  function lockLiteForSession(reason) {
    try { if (storage) storage.set(LOCK_KEY, "1"); } catch { }
    lockLite(reason);
  }

  let govActive = false;
  let govLast = 0;
  let govWindowStart = 0;
  let govDeltas = [];
  let govStrikes = 0;
  let govCancel = null;

  function judgeWindow(deltas) {
    if (deltas.length < 12) return -1;
    const { median, p95 } = frameStats(deltas);
    if (median > FRAME_BUDGET_MS) return 1;
    if (p95 > GOVERNOR_P95_MS && median > FRAME_BUDGET_MS * 0.85) return 1;
    return -1;
  }

  function governorFrame(t) {
    if (!govActive) return;
    if (govLast) govDeltas.push(t - govLast);
    govLast = t;
    if (!govWindowStart) govWindowStart = t;
    if (t - govWindowStart >= GOVERNOR_WINDOW_MS) {
      const verdict = judgeWindow(govDeltas);
      govWindowStart = t;
      govDeltas = [];
      if (verdict < 0) govStrikes = 0;
      else if (++govStrikes >= GOVERNOR_STRIKES) {
        lockLiteForSession("governor: cannot hold 60fps");
        return;
      }
    }
    govCancel = raf(governorFrame);
  }

  function startGovernor() {
    if (govActive) return;
    govActive = true;
    govLast = 0;
    govWindowStart = 0;
    govDeltas = [];
    govStrikes = 0;
    govCancel = raf(governorFrame);
  }

  function stopGovernor() {
    govActive = false;
    if (govCancel) { govCancel(); govCancel = null; }
  }

  let probing = false;
  let probed = false;

  function probe(makeSurface) {
    if (probed || probing || !visible() || self.locked) return false;
    probing = true;
    const surface = makeSurface ? makeSurface() : null;
    const deltas = [];
    let last = 0;
    let frame = 0;
    const step = t => {
      if (frame++ > PROBE_SKIP && last) deltas.push(t - last);
      last = t;
      if (frame < PROBE_FRAMES) { raf(step); return; }
      probed = true;
      probing = false;
      if (surface && surface.destroy) surface.destroy();
      if (!deltas.length) return;
      const { median, p95 } = frameStats(deltas);
      if (median <= FRAME_BUDGET_MS && p95 <= PROBE_P95_MS) {
        setMode("fx", "probe passed");
        startGovernor();
      } else {
        setMode("lite", `probe failed (median ${median.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms)`);
      }
    };
    raf(step);
    return true;
  }

  function start(makeSurface) {
    if (self.started) return;
    self.started = true;
    if (media("(prefers-reduced-motion: reduce)") || media("(update: slow)")) {
      lockLite("reduced motion / slow update");
      return;
    }
    let locked = false;
    try { locked = storage && storage.get(LOCK_KEY) === "1"; } catch { }
    if (locked) { lockLite("session lock (governor demoted earlier)"); return; }
    const beginProbe = () => {
      if (visible()) probe(makeSurface);
      else if (typeof onVisible === "function") onVisible(() => probe(makeSurface));
    };
    if (typeof delay === "function") delay(beginProbe, PROBE_DELAY_MS);
    else if (typeof setTimeout === "function") setTimeout(beginProbe, PROBE_DELAY_MS);
    else beginProbe();
  }

  return { gate: self, start, probe, lockLite, lockLiteForSession, startGovernor, stopGovernor, judgeWindow };
}

function initBrowserGate() {
  const raf = cb => {
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  };
  const makeSurface = () => {
    const stage = document.createElement("div");
    stage.setAttribute("data-perf-probe", "");
    stage.style.cssText = "position:fixed;left:0;top:0;width:420px;height:320px;z-index:-1;pointer-events:none;overflow:hidden;contain:strict;";
    const bg = document.createElement("div");
    bg.style.cssText = "position:absolute;left:0;top:0;width:840px;height:640px;background:repeating-linear-gradient(45deg,#0c111c 0 12px,#101a2c 12px 24px,#0d1322 24px 40px);animation:vm-probe-move 0.4s linear infinite;";
    const glass = document.createElement("div");
    glass.style.cssText = "position:absolute;inset:0;backdrop-filter:blur(14px) saturate(150%);-webkit-backdrop-filter:blur(14px) saturate(150%);";
    stage.append(bg, glass);
    const style = document.createElement("style");
    style.textContent = "@keyframes vm-probe-move{from{transform:translate3d(0,0,0)}to{transform:translate3d(-64px,-64px,0)}}";
    try { (document.head || root).append(style, stage); } catch { return { destroy() { } }; }
    return { destroy() { try { stage.remove(); style.remove(); } catch { } } };
  };
  const storage = {
    get(key) { return window.sessionStorage.getItem(key); },
    set(key, value) { window.sessionStorage.setItem(key, value); },
    remove(key) { window.sessionStorage.removeItem(key); }
  };
  let gateApi = null;
  try {
    gateApi = createPerfGate({
      root,
      media,
      raf,
      visible: () => !document.hidden,
      storage,
      delay: (fn, ms) => { setTimeout(fn, ms); },
      onVisible(cb) {
        const once = () => {
          if (document.hidden) return;
          document.removeEventListener("visibilitychange", once);
          cb();
        };
        document.addEventListener("visibilitychange", once);
      }
    });
    gateApi.start(makeSurface);
  } catch {
    gateApi = null;
  }
  if (typeof window !== "undefined") window.__vmPerf = gateApi;
}

if (hasDom) initBrowserGate();

export { createPerfGate, initBrowserGate, FRAME_BUDGET_MS, PROBE_FRAMES, GOVERNOR_WINDOW_MS };
