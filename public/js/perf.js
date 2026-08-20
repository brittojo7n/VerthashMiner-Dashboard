/*
 * Capability gate + runtime governor for the visual-effects tier.
 *
 * Modes:
 *   lite (default) - layered-gradient glass, no backdrop-filter, no looping
 *                    animations: the mode every device renders first.
 *   fx  (html.fx)  - real-time backdrop blur, deeper shadows, pulse/caret loops.
 *
 * Decision ladder (the expensive tier must be *earned*):
 *   1. prefers-reduced-motion / update:slow      -> lite, locked.
 *   2. session lock (a previous governor demote) -> lite, locked (per tab).
 *   3. memory <= 2 GB                            -> lite, locked (no probe:
 *      compositing budget is hopeless there, don't even spend a frame on it).
 *   4. memory >= 8 GB && cores >= 8              -> fx immediately (desktop
 *      class), governor still watches.
 *   5. everything else (incl. 4 GB tablets, whose deviceMemory rounds down to
 *      4) -> render a real blurred surface and hold 60fps against it for
 *      ~0.7s. Pass: fx. Fail: lite.
 *   6. while fx is active a governor samples real frame times; if the device
 *      cannot hold the 60fps budget for two consecutive windows it demotes to
 *      lite and locks the session - so a mis-classified tablet self-heals
 *      within seconds instead of janking until the next reload.
 */

const FRAME_BUDGET_MS = 17;      // 60fps frame budget
const PROBE_FRAMES = 42;         // ~0.7s at 60Hz
const PROBE_SKIP = 4;            // discard warm-up frames
const PROBE_DELAY_MS = 600;      // let first-load compile/GC settle before probing
const PROBE_P95_MS = 25;         // probe surface is small: hold close to 60fps on it
const GOVERNOR_WINDOW_MS = 1500; // strike window
const GOVERNOR_STRIKES = 2;      // consecutive strikes -> demote
const GOVERNOR_P95_MS = 34;      // sustained worst-frame ceiling (~1 dropped frame)
const LOCK_KEY = "vmd:fxLock";   // sessionStorage: this tab stays lite

function createPerfGate(env) {
  const {
    root,
    media,
    raf,                          // raf(cb) -> cancel()
    visible,                      // () => boolean
    navigatorLike,
    storage,                      // { get(k), set(k,v), remove(k) } or null
    onChange,                     // (mode) => void
    onVisible,                    // (cb) => void; called when page becomes visible
    delay,                        // (fn, ms) => void; deferred task runner
    now = Date.now
  } = env;

  const self = {
    mode: "lite",
    locked: false,
    reason: "boot",
    started: false
  };

  function setMode(mode, reason) {
    self.reason = reason;
    const changed = self.mode !== mode;
    self.mode = mode;
    // the class always mirrors the mode, even on a repeat call, so a demotion
    // also clears an externally-forced fx tier
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

  /* ---- runtime governor: real frame times while fx is live ---- */
  let govActive = false;
  let govLast = 0;
  let govWindowStart = 0;
  let govDeltas = [];
  let govStrikes = 0;
  let govCancel = null;

  function governorFrame(t) {
    if (!govActive) return;
    if (govLast) govDeltas.push(t - govLast);
    govLast = t;
    if (!govWindowStart) govWindowStart = t;
    if (t - govWindowStart >= GOVERNOR_WINDOW_MS) {
      const verdict = judgeWindow(govDeltas);
      govWindowStart = t;
      govDeltas = [];
      if (verdict < 0) {
        govStrikes = 0; // healthy window resets the strike count
      } else if (++govStrikes >= GOVERNOR_STRIKES) {
        lockLiteForSession("governor: cannot hold 60fps");
        return;
      }
    }
    govCancel = raf(governorFrame);
  }

  // <0 healthy, >=0 severity of the miss
  function judgeWindow(deltas) {
    if (deltas.length < 12) return -1; // not enough signal (tab hidden, etc.)
    const sorted = deltas.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    if (median > FRAME_BUDGET_MS) return 1;
    if (p95 > GOVERNOR_P95_MS && median > FRAME_BUDGET_MS * 0.85) return 1;
    return -1;
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

  /* ---- compositing probe: measure a *real* blurred surface ---- */
  let probing = false;
  let probed = false;
  function probe(makeSurface) {
    if (probed || probing || !visible()) return false;
    probing = true;
    const surface = makeSurface ? makeSurface() : null;
    const deltas = [];
    let last = 0;
    let frame = 0;
    let cancel = null;
    const step = t => {
      if (frame++ > PROBE_SKIP && last) deltas.push(t - last);
      last = t;
      if (frame < PROBE_FRAMES) { cancel = raf(step); return; }
      probed = true;
      probing = false;
      if (surface && surface.destroy) surface.destroy();
      if (!deltas.length) return;
      deltas.sort((a, b) => a - b);
      const median = deltas[deltas.length >> 1];
      const p95 = deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.95))];
      if (median <= FRAME_BUDGET_MS && p95 <= PROBE_P95_MS) {
        setMode("fx", "probe passed");
        startGovernor();
      } else {
        setMode("lite", `probe failed (median ${median.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms)`);
      }
    };
    cancel = raf(step);
    return true;
  }

  /* ---- decision ladder ---- */
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
    const memory = navigatorLike ? Number(navigatorLike.deviceMemory) || 0 : 0;
    const cores = navigatorLike ? Number(navigatorLike.hardwareConcurrency) || 0 : 0;
    if (memory > 0 && memory <= 2) { lockLite("low device memory"); return; }
    if (memory >= 8 && cores >= 8) {
      setMode("fx", "desktop class");
      startGovernor();
      return;
    }
    // mid class (4 GB tablets, unknown memory): prove the compositor first,
    // after the initial parse/compile burst has settled
    const beginProbe = () => { if (visible()) probe(makeSurface); else if (typeof onVisible === "function") onVisible(() => probe(makeSurface)); };
    if (typeof delay === "function") delay(beginProbe, PROBE_DELAY_MS);
    else if (typeof setTimeout === "function") setTimeout(beginProbe, PROBE_DELAY_MS);
    else beginProbe();
  }

  return { gate: self, start, probe, lockLite, lockLiteForSession, startGovernor, stopGovernor, judgeWindow };
}

/* ---- browser bootstrap ---- */
function initBrowserGate() {
  const root = document.documentElement;
  const media = query => (typeof matchMedia === "function" ? matchMedia(query).matches : false);
  const raf = cb => { const id = requestAnimationFrame(cb); return () => cancelAnimationFrame(id); };

  // A throwaway surface with the app's real glass recipe: an animated backdrop
  // (compositor-only transform) sampled through backdrop-filter. This measures
  // exactly the work the fx tier would do, on this device, right now. The
  // gradient uses near-background tones so the ~0.7s probe is invisible.
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
    return {
      destroy() {
        try { stage.remove(); style.remove(); } catch { }
      }
    };
  };

  const storage = {
    get(key) { return window.sessionStorage.getItem(key); },
    set(key, value) { window.sessionStorage.setItem(key, value); },
    remove(key) { window.sessionStorage.removeItem(key); }
  };

  let gateApi;
  try {
    gateApi = createPerfGate({
      root,
      media,
      raf,
      visible: () => !document.hidden,
      navigatorLike: typeof navigator === "object" ? navigator : {},
      storage,
      delay: (fn, ms) => { setTimeout(fn, ms); },
      onVisible(cb) {
        const once = () => {
          if (document.hidden) return;
          document.removeEventListener("visibilitychange", once);
          cb();
        };
        document.addEventListener("visibilitychange", once);
      },
      onChange(mode) {
        if (mode === "lite" && root.classList.contains("fx")) {
          // demote: drop the fx-only looping animations immediately
          void root.offsetWidth; // flush so animations restart clean if re-enabled later
        }
      }
    });
    gateApi.start(makeSurface);
  } catch {
    gateApi = null;
  }
  if (typeof window !== "undefined") window.__vmPerf = gateApi;
}

if (typeof document !== "undefined" && typeof document.documentElement === "object") {
  initBrowserGate();
}

export { createPerfGate, initBrowserGate, FRAME_BUDGET_MS, PROBE_FRAMES, GOVERNOR_WINDOW_MS };
