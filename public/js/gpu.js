import { make, text, className, style } from "./dom.js";
import { num, tempClass, DASH } from "./format.js";

/**
 * GPU telemetry cards.
 *
 * Cards are built once and then patched through retained node references, so a
 * refresh costs a handful of string comparisons rather than a DOM rebuild or a
 * `getElementById` per field.
 */

/** Simple metric tiles, in display order: [label, unit]. */
const FIELDS = [
  ["pstate", "P-State", ""],
  ["temp", "GPU Temp", ""],
  ["power", "Power", "W"],
  ["core", "Core Clock", "MHz"],
  ["mem", "Memory Clock", "MHz"]
];

let cards = [];
let host = null;

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

  // VRAM: used / total
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

  // Hashrate + efficiency
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

  // Utilisation bar
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

/** Show a message in place of the cards (no data yet, or a telemetry failure). */
function renderNotice(container, gpuError) {
  cards = [];
  container.textContent = "";
  if (!gpuError) {
    container.appendChild(make("div", "small gpu-empty", "Waiting for GPU telemetry data..."));
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
  host = container;

  if (!gpus || gpus.length === 0) {
    renderNotice(container, gpuError);
    return;
  }

  if (cards.length !== gpus.length) {
    cards = gpus.map((_, i) => buildCard(i));
    container.textContent = "";
    const frag = document.createDocumentFragment();
    for (const card of cards) frag.appendChild(card.panel);
    container.appendChild(frag);
  }

  for (let i = 0; i < gpus.length; i++) {
    const gpu = gpus[i];
    const r = cards[i].refs;

    text(r.name, `GPU ${gpu.index} \u2022 ${gpu.name || "Unknown"}`);
    text(r.pstate, gpu.pstate || DASH);
    text(r.temp, gpu.temperatureC != null ? `${num(gpu.temperatureC, 0)}\u00b0C` : DASH);
    className(r.tempBox, `mvalue ${tempClass(gpu.temperatureC)}`);
    text(r.power, num(gpu.powerW, 1));
    text(r.core, num(gpu.coreMHz, 0));
    text(r.mem, num(gpu.memoryMHz, 0));
    text(r.vramUsed, num(gpu.memoryUsedMB, 0));
    text(r.vramTotal, num(gpu.memoryTotalMB, 0));
    text(r.hashrate, gpu.hashrate != null ? num(gpu.hashrate, 2) : DASH);

    const eff = gpu.hashrate > 0 && gpu.powerW > 0 ? gpu.hashrate / gpu.powerW : null;
    text(r.eff, eff != null ? num(eff, 2) : DASH);

    const util = gpu.utilizationPct == null ? 0 : Math.max(0, Math.min(100, gpu.utilizationPct));
    text(r.util, num(gpu.utilizationPct, 1));
    style(r.bar, "width", `${util}%`);
  }
}
