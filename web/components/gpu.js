import { make, text, className, style } from "../lib/dom.js";
import { DASH, presentGpu } from "../lib/present.js";

const COUNT_KEY = "vmd:gpuCount";

export const DEFAULT_SPEC = Object.freeze({
  tempLevels: Object.freeze({ warn: 72, hot: 80 }),
  metrics: Object.freeze([
    { key: "pstate", label: "P-State", cls: "mvalue-accent" },
    { key: "temp", label: "GPU Temp", tempClass: true },
    { key: "power", label: "Power", unit: "W" },
    { key: "core", label: "Core Clock", unit: "MHz" },
    { key: "mem", label: "Memory Clock", unit: "MHz" },
    { key: "vram", label: "VRAM", unit: "MB", small: true, parts: ["vramUsed", "vramTotal"] },
    { key: "hashrate", label: "Hashrate", unit: "kH/s", cls: "gradient-text" },
    { key: "eff", label: "Efficiency", unit: "kH/s/W" }
  ]),
  util: Object.freeze({ label: "Compute Utilization", unit: "%" })
});

let cards = [];
let hasPlaceholder = false;

function knownGpuCount() {
  try { const n = Number.parseInt(localStorage.getItem(COUNT_KEY), 10); return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 1; } catch { return 1; }
}
function rememberGpuCount(n) { try { if (Number.isInteger(n) && n >= 1 && n <= 8) localStorage.setItem(COUNT_KEY, String(n)); } catch { } }

function valueKeys(spec) {
  const keys = [];
  for (const m of spec.metrics) { if (m.parts) keys.push(...m.parts); else keys.push(m.key); }
  keys.push("util");
  return keys;
}

function buildMetric(m) {
  const cell = make("div", "metric");
  cell.appendChild(make("div", "label", m.label));
  const value = make("div", ["mvalue", m.small && "mvalue-sm", m.cls].filter(Boolean).join(" "));
  const refs = {};
  if (m.parts) {
    const used = make("span");
    const total = make("span");
    const unit = make("span", "unit");
    unit.append("/ ", total, m.unit ? ` ${m.unit}` : "");
    value.append(used, " ", unit);
    refs[m.parts[0]] = used;
    refs[m.parts[1]] = total;
  } else {
    const span = make("span");
    if (m.unit) value.append(span, " ", make("span", "unit", m.unit));
    else value.appendChild(span);
    refs[m.key] = span;
  }
  cell.appendChild(value);
  if (m.tempClass) refs.tempBox = value;
  return { cell, refs };
}

function buildUtil(u) {
  const block = make("div", "metric metric-util");
  const row = make("div", "flex-between-end");
  row.appendChild(make("div", "label m-0", u.label));
  const value = make("div", "mvalue mvalue-sm m-0");
  const span = make("span");
  value.append(span, u.unit);
  row.appendChild(value);
  const barBg = make("div", "bar-bg");
  const bar = make("div", "bar-fill");
  barBg.appendChild(bar);
  block.append(row, barBg);
  return { block, refs: { util: span, bar } };
}

export function buildCard(spec = DEFAULT_SPEC) {
  const panel = make("div", "gpu-panel");
  const head = make("div", "gpu-head");
  const name = make("div", "gpu-name");
  head.appendChild(name);
  const metrics = make("div", "metrics mt-0");
  const refs = { name };
  const tempBoxes = [];
  for (const m of spec.metrics) {
    const { cell, refs: r } = buildMetric(m);
    Object.assign(refs, r);
    if (m.tempClass) tempBoxes.push(r.tempBox);
    metrics.appendChild(cell);
  }
  const { block, refs: ur } = buildUtil(spec.util);
  Object.assign(refs, ur);
  panel.append(head, metrics, block);
  return { panel, refs, tempBoxes };
}

function resetCard(card, spec) {
  text(card.refs.name, "Detecting GPUs\u2026");
  for (const key of valueKeys(spec)) text(card.refs[key], DASH);
  for (const box of card.tempBoxes) className(box, "mvalue");
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
  const title = make("div", null, "GPU telemetry unavailable");
  title.style.color = "var(--red)";
  title.style.fontWeight = "600";
  title.style.marginBottom = "4px";
  const detail = make("div", null, /ENOENT|not found|not recognized/i.test(gpuError) ? "nvidia-smi could not be found. Ensure NVIDIA drivers are installed and nvidia-smi is in your system PATH." : gpuError);
  box.append(title, detail);
  container.appendChild(box);
}

export function render(container, gpus, gpuError, spec = DEFAULT_SPEC) {
  if (!gpus || gpus.length === 0) { showNotice(container, gpuError, spec); return; }
  rememberGpuCount(gpus.length);
  if (hasPlaceholder || cards.length !== gpus.length) {
    hasPlaceholder = false;
    cards = gpus.map(() => buildCard(spec));
    container.textContent = "";
    const frag = document.createDocumentFragment();
    for (const card of cards) frag.appendChild(card.panel);
    container.appendChild(frag);
    requestAnimationFrame(() => {
      try { localStorage.setItem("vmd:gpuH", String(container.offsetHeight)); document.documentElement.style.removeProperty("--gpus-min"); } catch { }
    });
  }
  for (let i = 0; i < gpus.length; i++) {
    const v = presentGpu(gpus[i], spec.tempLevels);
    const r = cards[i].refs;
    text(r.name, v.name);
    for (const m of spec.metrics) {
      if (m.parts) { text(r[m.parts[0]], v[m.parts[0]]); text(r[m.parts[1]], v[m.parts[1]]); }
      else text(r[m.key], v[m.key]);
      if (m.tempClass) className(r.tempBox, `mvalue ${v.tempClass}`);
    }
    text(r.util, v.util);
    style(r.bar, "transform", `scaleX(${v.barScale})`);
  }
}
