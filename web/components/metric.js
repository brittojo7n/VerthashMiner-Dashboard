import { make, text } from "../lib/dom.js";
import { DASH } from "../lib/present.js";

const ACCENT_CLASS = {
  cyan: "accent-cyan",
  green: "accent-green",
  red: "accent-red",
  amber: "accent-amber",
  violet: "accent-violet",
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
    cls = "",
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
    const isArr = Array.isArray(parts);
    refs.parts = {};
    const items = isArr ? parts : [
      { key: "used", value: parts.used, unit: "" },
      { key: "total", value: parts.total, unit: "" },
    ];
    items.forEach((p, i) => {
      if (i > 0) valueBox.appendChild(make("span", "metric-sep", p.sep || (isArr ? " \u2022 " : " / ")));
      const item = make("span", "metric-part");
      if (p.accent && ACCENT_CLASS[p.accent]) item.classList.add(ACCENT_CLASS[p.accent]);
      const num = make("span", "metric-num", p.value != null ? String(p.value) : DASH);
      item.appendChild(num);
      if (p.unit) {
        const u = make("span", "metric-unit", p.unit);
        item.append(document.createTextNode(" "), u);
        refs.parts[`${p.key}Unit`] = u;
      }
      valueBox.appendChild(item);
      refs.parts[p.key] = num;
      refs[p.key] = num;
    });
    const unitEl = make("span", "metric-unit", unit || "");
    if (!unit) unitEl.style.display = "none";
    if (unit) valueBox.append(document.createTextNode(" "), unitEl);
    refs.unit = unitEl;
  } else {
    const num = make("span", "metric-num", value != null ? String(value) : DASH);
    valueBox.appendChild(num);
    const unitEl = make("span", "metric-unit", unit || "");
    if (!unit) unitEl.style.display = "none";
    if (unit && unit !== "%") valueBox.append(document.createTextNode(" "));
    valueBox.append(unitEl);
    refs.num = num;
    refs.unit = unitEl;
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
        for (const [k, v] of Object.entries(next.parts)) {
          if (refs.parts && refs.parts[k]) text(refs.parts[k], v);
          else if (refs[k]) text(refs[k], v);
        }
      }
      if (next.accent !== undefined) currentAccent = next.accent;
      if (next.status !== undefined) currentStatus = next.status;
      if (next.accent !== undefined || next.status !== undefined) {
        applyAccent(valueBox, currentAccent, currentStatus);
      }
      return this;
    },
  };
}
