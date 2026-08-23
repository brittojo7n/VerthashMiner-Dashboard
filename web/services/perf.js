const hasDom =
  typeof document !== "undefined" &&
  typeof document.documentElement === "object";
const root = hasDom ? document.documentElement : null;
const media = (query) =>
  typeof matchMedia === "function" ? matchMedia(query).matches : false;
const LOCK_KEY = "vmd:fxLock";

function createPerfGate(env) {
  const { root, media, storage } = env;
  const self = { mode: "lite", locked: false, reason: "boot", started: false };

  function setMode(mode, reason) {
    self.reason = reason;
    const changed = self.mode !== mode;
    self.mode = mode;
    if (root && root.classList) {
      if (mode === "fx") root.classList.add("fx");
      else root.classList.remove("fx");
    }
  }

  function lockLite(reason) {
    self.locked = true;
    setMode("lite", reason);
  }

  function probe() {
    if (self.locked) return false;
    const isWeakDevice = (navigator.hardwareConcurrency || 4) < 4;
    if (isWeakDevice) {
      setMode("lite", "weak device");
    } else {
      setMode("fx", "probe passed");
    }
    return true;
  }

  function start() {
    if (self.started) return;
    self.started = true;
    if (media("(prefers-reduced-motion: reduce)") || media("(update: slow)")) {
      lockLite("reduced motion");
      return;
    }
    let locked = false;
    try {
      locked = storage && storage.get(LOCK_KEY) === "1";
    } catch (err) {
      console.error("[dashboard] perf gate lock check failed:", err.message);
    }
    if (locked) {
      lockLite("session lock");
      return;
    }
    probe();
  }

  return { gate: self, start, probe, lockLite };
}

function initBrowserGate() {
  const storage = {
    get(key) {
      return window.sessionStorage.getItem(key);
    },
    set(key, value) {
      window.sessionStorage.setItem(key, value);
    },
    remove(key) {
      window.sessionStorage.removeItem(key);
    },
  };
  let gateApi = null;
  try {
    gateApi = createPerfGate({ root, media, storage });
    gateApi.start();
  } catch {
    gateApi = null;
  }
  if (typeof window !== "undefined") window.__vmPerf = gateApi;
}

if (hasDom) initBrowserGate();
export { createPerfGate, initBrowserGate };
