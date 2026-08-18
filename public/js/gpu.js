import { make, text, className, style } from "./dom.js";
import { DASH } from "./format.js";
import { presentGpu } from "./present.js";

const FIELDS = [
  ["pstate", "P-State", ""],
  ["temp", "GPU Temp", ""],
  ["power", "Power", "W"],
  ["core", "Core Clock", "MHz"],
  ["mem", "Memory Clock", "MHz"]
];

let cards = [];
let placeholder = false;

function buildCard(index) {
  const panel = make("div", "gpu-panel");
  const head = make("div", "gpu-head");
  const name = make("div", "gpu-name");
  head.appendChild(name);

  const metrics = make("div", "metrics mt-0");
  const refs = { name };

  for (const [key, label, unit] of FIELDS) {
    const metric = make("div", "metric");
    metric.appendChild(make("div", "label", label));
    const value = make("div", "mvalue");
    if (unit) {
      const span = make("span");
      value.append(span, " ", make("span", "unit", unit));
      refs[key] = span;
    } else {
      refs[key] = value;
    }
    if (key === "pstate") value.style.color = "var(--accent2)";
    if (key === "temp") refs.tempBox = value;
    metric.appendChild(value);
    metrics.appendChild(metric);
  }

  const vram = make("div", "metric");
  vram.appendChild(make("div", "label", "VRAM"));
  const vramValue = make("div", "mvalue mvalue-sm");
  refs.vramUsed = make("span");
  refs.vramTotal = make("span");
  const vramUnit = make("span", "unit");
  vramUnit.append("/ ", refs.vramTotal, " MB");
  vramValue.append(refs.vramUsed, " ", vramUnit);
  vram.appendChild(vramValue);
  metrics.appendChild(vram);

  for (const [key, label, unit, cls] of [
    ["hashrate", "Hashrate", "kH/s", "mvalue gradient-text"],
    ["eff", "Efficiency", "kH/s/W", "mvalue"]
  ]) {
    const metric = make("div", "metric");
    metric.appendChild(make("div", "label", label));
    const value = make("div", cls);
    refs[key] = make("span", null, DASH);
    value.append(refs[key], " ", make("span", "unit", unit));
    metric.appendChild(value);
    metrics.appendChild(metric);
  }

  const util = make("div", "metric metric-util");
  const row = make("div", "flex-between-end");
  row.appendChild(make("div", "label m-0", "Compute Utilization"));
  const utilValue = make("div", "mvalue mvalue-sm m-0");
  refs.util = make("span");
  utilValue.append(refs.util, "%");
  row.appendChild(utilValue);
  const barBg = make("div", "bar-bg");
  refs.bar = make("div", "bar-fill");
  barBg.appendChild(refs.bar);
  util.append(row, barBg);

  panel.append(head, metrics, util);
  return { panel, refs, index };
}

/**
 * Skeleton card shown before the first nvidia-smi sample lands.
 * It occupies exactly the space a real card will, so the arrival of telemetry
 * does not push the rest of the page down (cumulative layout shift).
 */
function renderSkeleton(container) {
  if (placeholder && cards.length === 1) return;
  cards = [buildCard(0)];
  placeholder = true;
  container.textContent = "";
  const { refs, panel } = cards[0];
  text(refs.name, "Detecting GPUs\u2026");
  for (const key of ["pstate", "temp", "power", "core", "mem", "vramUsed", "vramTotal", "util"]) {
    text(refs[key], DASH);
  }
  container.appendChild(panel);
}

function renderNotice(container, gpuError) {
  cards = [];
  placeholder = false;
  container.textContent = "";
  if (!gpuError) {
    renderSkeleton(container);
    return;
  }
  const box = make("div", "small gpu-empty");
  const title = make("div", null, "GPU telemetry unavailable");
  title.style.color = "var(--red)";
  title.style.fontWeight = "600";
  title.style.marginBottom = "4px";
  const detail = make("div", null, /ENOENT|not found|not recognized/i.test(gpuError)
    ? "nvidia-smi could not be found. Ensure NVIDIA drivers are installed and nvidia-smi is in your system PATH."
    : gpuError);
  box.append(title, detail);
  container.appendChild(box);
}

export function render(container, gpus, gpuError) {
  if (!gpus || gpus.length === 0) {
    if (!gpuError) renderSkeleton(container);
    else renderNotice(container, gpuError);
    return;
  }

  if (placeholder || cards.length !== gpus.length) {
    placeholder = false;
    cards = gpus.map((_, i) => buildCard(i));
    container.textContent = "";
    const frag = document.createDocumentFragment();
    for (const card of cards) frag.appendChild(card.panel);
    container.appendChild(frag);
  }

  for (let i = 0; i < gpus.length; i++) {
    const v = presentGpu(gpus[i]);
    const r = cards[i].refs;

    text(r.name, v.name);
    text(r.pstate, v.pstate);
    text(r.temp, v.temp);
    className(r.tempBox, `mvalue ${v.tempClass}`);
    text(r.power, v.power);
    text(r.core, v.core);
    text(r.mem, v.mem);
    text(r.vramUsed, v.vramUsed);
    text(r.vramTotal, v.vramTotal);
    text(r.hashrate, v.hashrate);
    text(r.eff, v.eff);
    text(r.util, v.util);
    style(r.bar, "width", v.barWidth);
  }
}
