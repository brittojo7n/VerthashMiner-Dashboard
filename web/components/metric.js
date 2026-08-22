import { make, text } from "../lib/dom.js";
import { DASH } from "../lib/present.js";

/**
 * Reusable telemetry metric component.
 *
 * Single source of truth for every numeric readout in the dashboard:
 * top-level summary cards (Hashrate / Shares / Acceptance / Uptime) and the
 * nested GPU + mining stat tiles (P-State, Temp, Power, Clocks, VRAM,
 * Efficiency, Rejected, Difficulty, ...).
 *
 * Options:
 *   label   - secondary metric label (uppercased via CSS)
 *   value   - initial value string
 *   unit    - optional unit suffix (rendered dimmed)
 *   accent  - semantic accent: "cyan" | "green" | "red" | "amber" | "violet"
 *   status  - dynamic semantic state: "ok" | "warn" | "danger" (overrides accent)
 *   surface - elevation level: 1 (primary card) | 2 (nested tile)
 *   bar     - render a progress bar (utilization) instead of a plain value row
 *   parts   - { used, total } split value rendering (VRAM)
 *   small   - compact value typography (Last Share, utilization)
 *   cls     - extra classes
 */

const ACCENT_CLASS = {
  cyan: "accent-cyan",
  green: "accent-green",
  red: "accent-red",
  amber: "accent-amber",
  violet: "accent-violet"
};

const STATUS_ACCENT = { ok: "green", warn: "amber", danger: "red" };

function accentKey(accent, status) {
  if (status && STATUS_ACCENT[status]) return STATUS_ACCENT[status];
  return accent && ACCENT_CLASS[accent] ? accent : null;
}

function applyAccent(el, accent, status) {
  for (const cls of Object.values(ACCENT_CLASS)) el.classList.remove(cls);
  const key = accentKey(accent, status);
  if (key) el.classList.add(ACCENT_CLASS[key]);
}

export function createMetric(opts = {}) {
  const {
    label = "",
    value = DASH,
    unit = "",
    accent = null,
    status = null,
    surface = 2,
    bar = false,
    parts = null,
    small = false,
    cls = ""
  } = opts;

  const node = make("div", "metric");
  node.classList.add(surface === 1 ? "metric--card" : "metric--tile");
  if (small) node.classList.add("metric--small");
  if (cls) node.classList.add(cls);

  const labelEl = make("div", "metric-label", label);
  const valueBox = make("div", "metric-value");
  node.append(labelEl, valueBox);

  const refs = { node, label: labelEl, value: valueBox };

  if (parts) {
    const used = make("span", "metric-num", parts.used != null ? parts.used : DASH);
    const total = make("span", "metric-num", parts.total != null ? parts.total : DASH);
    valueBox.append(used, document.createTextNode(" / "), total);
    if (unit) valueBox.append(document.createTextNode(" "), make("span", "metric-unit", unit));
    refs.used = used;
    refs.total = total;
  } else {
    const num = make("span", "metric-num", value != null ? String(value) : DASH);
    valueBox.appendChild(num);
    if (unit) {
      if (unit !== "%") valueBox.append(document.createTextNode(" "));
      valueBox.append(make("span", "metric-unit", unit));
    }
    refs.num = num;
  }

  if (bar) {
    const track = make("div", "metric-bar");
    const fill = make("div", "metric-bar-fill");
    track.appendChild(fill);
    node.appendChild(track);
    refs.bar = fill;
  }

  let currentAccent = accent;
  let currentStatus = status;
  applyAccent(valueBox, accent, status);

  return {
    node,
    refs,
    set(next = {}) {
      if (next.value !== undefined) text(refs.num, next.value);
      if (next.parts !== undefined) {
        if (next.parts.used !== undefined) text(refs.used, next.parts.used);
        if (next.parts.total !== undefined) text(refs.total, next.parts.total);
      }
      if (next.accent !== undefined) currentAccent = next.accent;
      if (next.status !== undefined) currentStatus = next.status;
      if (next.accent !== undefined || next.status !== undefined) {
        applyAccent(valueBox, currentAccent, currentStatus);
      }
      return this;
    }
  };
}
