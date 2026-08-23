import { make, text, style } from "../lib/dom.js";
import { createMetric } from "./metric.js";
import { DASH, presentGpu } from "../lib/present.js";

const COUNT_KEY = "vmd:gpuCount";

const DEFAULT_SPEC = Object.freeze({
  tempLevels: Object.freeze({ warn: 72, hot: 80 }),
  metrics: Object.freeze([
    { key: "pstate", label: "P-State" },
    { key: "temp", label: "GPU Temp", status: true },
    { key: "power", label: "Power", unit: "W" },
    { key: "core", label: "Core Clock", unit: "MHz" },
    { key: "mem", label: "Memory Clock", unit: "MHz" },
    {
      key: "vram",
      label: "VRAM",
      unit: "MB",
      parts: ["vramUsed", "vramTotal"],
    },
    { key: "hashrate", label: "Hashrate", unit: "kH/s", accent: "cyan" },
    { key: "eff", label: "Efficiency", unit: "kH/s/W" },
  ]),
  util: Object.freeze({ label: "Compute Utilization", unit: "%" }),
});

let cards = [];
let hasPlaceholder = false;

function knownGpuCount() {
  try {
    const n = Number.parseInt(localStorage.getItem(COUNT_KEY), 10);
    return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 1;
  } catch {
    return 1;
  }
}
function rememberGpuCount(n) {
  try {
    if (Number.isInteger(n) && n >= 1 && n <= 8)
      localStorage.setItem(COUNT_KEY, String(n));
  } catch {}
}

function buildCard(spec = DEFAULT_SPEC) {
  const panel = make("div", "gpu-panel");
  const head = make("div", "gpu-head");
  const name = make("div", "gpu-name");
  head.appendChild(name);

  const metrics = make("div", "metrics mt-0");
  const refs = { name };
  const metricRefs = [];
  for (const m of spec.metrics) {
    const metric = createMetric({
      label: m.label,
      unit: m.unit || "",
      accent: m.accent || null,
      surface: 2,
      parts: m.parts ? { used: DASH, total: DASH } : null,
    });
    metrics.appendChild(metric.node);
    refs[m.key] = metric;
    metricRefs.push({ m, metric });
  }

  const util = createMetric({
    label: spec.util.label,
    unit: spec.util.unit,
    surface: 2,
    bar: true,
    small: true,
    cls: "metric--util",
  });
  metrics.appendChild(util.node);
  panel.append(head, metrics);
  refs.util = util;

  return { panel, refs, metricRefs };
}

function resetCard(card, spec) {
  text(card.refs.name, "Detecting GPUs\u2026");
  for (const m of spec.metrics) {
    const metric = card.refs[m.key];
    if (m.parts) metric.set({ parts: { used: DASH, total: DASH } });
    else metric.set({ value: DASH, status: null, accent: m.accent || null });
  }
  card.refs.util.set({ value: DASH });
  style(card.refs.util.refs.bar, "transform", "scaleX(0)");
}

function showNotice(container, gpuError, spec) {
  cards = [];
  hasPlaceholder = false;
  container.textContent = "";
  if (!gpuError) {
    const count = knownGpuCount();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const card = buildCard(spec);
      resetCard(card, spec);
      cards.push(card);
      frag.appendChild(card.panel);
    }
    container.appendChild(frag);
    hasPlaceholder = true;
    return;
  }
  const box = make("div", "small gpu-empty");
  const title = make("div", "gpu-empty-title", "GPU telemetry unavailable");
  const detail = make(
    "div",
    null,
    /ENOENT|not found|not recognized/i.test(gpuError)
      ? "nvidia-smi could not be found. Ensure NVIDIA drivers are installed and nvidia-smi is in your system PATH."
      : gpuError,
  );
  box.append(title, detail);
  container.appendChild(box);
}

export function render(container, gpus, gpuError, spec = DEFAULT_SPEC) {
  if (!gpus || gpus.length === 0) {
    showNotice(container, gpuError, spec);
    return;
  }
  rememberGpuCount(gpus.length);
  if (hasPlaceholder || cards.length !== gpus.length) {
    hasPlaceholder = false;
    cards = gpus.map(() => buildCard(spec));
    container.textContent = "";
    const frag = document.createDocumentFragment();
    for (const card of cards) frag.appendChild(card.panel);
    container.appendChild(frag);
  }
  for (let i = 0; i < gpus.length; i++) {
    const v = presentGpu(gpus[i], spec.tempLevels);
    const r = cards[i].refs;
    text(r.name, v.name);
    for (const m of spec.metrics) {
      const metric = r[m.key];
      if (m.parts)
        metric.set({ parts: { used: v[m.parts[0]], total: v[m.parts[1]] } });
      else if (m.status) metric.set({ value: v[m.key], status: v.tempStatus });
      else metric.set({ value: v[m.key] });
    }
    r.util.set({ value: v.util });
    style(r.util.refs.bar, "transform", `scaleX(${v.barScale})`);
  }
}
