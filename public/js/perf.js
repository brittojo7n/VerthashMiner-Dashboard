const root = document.documentElement;
const media = query => (typeof matchMedia === "function" ? matchMedia(query).matches : false);

const PROBE_FRAMES = 12;
const PROBE_SKIP = 2;
const FRAME_BUDGET_MS = 18;

let lite = true;
let probed = false;

function enable() {
  if (!lite) return;
  lite = false;
  if (root && root.classList) root.classList.add("fx");
}

function probe() {
  if (probed || document.hidden || typeof requestAnimationFrame !== "function") return;
  probed = true;

  const deltas = [];
  let last = 0;
  let frame = 0;

  const step = now => {
    if (frame++ > PROBE_SKIP && last) deltas.push(now - last);
    last = now;
    if (frame < PROBE_FRAMES) {
      requestAnimationFrame(step);
      return;
    }
    if (!deltas.length) return;
    deltas.sort((a, b) => a - b);
    if (deltas[deltas.length >> 1] <= FRAME_BUDGET_MS) enable();
  };

  requestAnimationFrame(step);
}

if (!media("(prefers-reduced-motion: reduce)") && !media("(update: slow)")) {
  const nav = typeof navigator === "object" && navigator ? navigator : {};
  const memory = nav.deviceMemory || 0;
  const cores = nav.hardwareConcurrency || 0;

  if (memory >= 4 || (!memory && cores >= 8)) {
    enable();
  } else if (!memory || memory > 2) {
    if (document.hidden) {
      document.addEventListener("visibilitychange", function once() {
        document.removeEventListener("visibilitychange", once);
        probe();
      });
    } else {
      probe();
    }
  }
}
