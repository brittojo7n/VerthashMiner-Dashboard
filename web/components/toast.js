import { el, make } from "../lib/dom.js";
const DEFAULT_MS = 3000;
const MAX_VISIBLE = 4;
const ICONS = {
  info: "i",
  warn: "!",
  error: "\u00d7",
  success: "\u2713",
  neutral: "\u25a0",
};
const live = new Map();
let stack = null;
const container = () => (stack ||= el("toastStack"));
export function dismiss(key, immediate = false) {
  const entry = live.get(key);
  if (!entry) return;
  live.delete(key);
  clearTimeout(entry.timer);
  if (immediate) {
    entry.node.remove();
    return;
  }
  entry.node.classList.replace("show", "hide");
  const remove = () => entry.node.remove();
  entry.node.addEventListener("transitionend", remove, { once: true });
  setTimeout(remove, 400);
}
export function show({
  key,
  title,
  message,
  variant = "info",
  duration = DEFAULT_MS,
}) {
  const host = container();
  if (!host) return;
  const id = key || `t${Date.now()}${Math.random()}`;
  const existing = live.get(id);
  if (existing) {
    existing.node.className = `toast toast-${variant} show`;
    existing.icon.textContent = ICONS[variant] || ICONS.info;
    existing.title.textContent = title;
    existing.message.textContent = message;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => dismiss(id), duration);
    return;
  }
  let overflow = [];
  while (live.size >= MAX_VISIBLE) {
    const [oldestKey] = live.keys();
    const entry = live.get(oldestKey);
    overflow.push(entry);
    live.delete(oldestKey);
  }
  for (const entry of overflow) {
    clearTimeout(entry.timer);
    entry.node.remove();
  }
  const node = make("div", `toast toast-${variant}`);
  node.setAttribute("role", variant === "error" ? "alert" : "status");
  const icon = make("div", "toast-icon", ICONS[variant] || ICONS.info);
  const body = make("div", "toast-body");
  const titleEl = make("div", "toast-title", title);
  const messageEl = make("div", "toast-msg", message);
  body.append(titleEl, messageEl);
  node.append(icon, body);
  node.addEventListener("click", () => dismiss(id));
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add("show"));
  live.set(id, {
    node,
    icon,
    title: titleEl,
    message: messageEl,
    timer: setTimeout(() => dismiss(id), duration),
  });
}
const variant = (name) => (title, message, key) =>
  show({ key, title, message, variant: name });
export const info = variant("info");
export const warn = variant("warn");
export const error = variant("error");
export const success = variant("success");
export const neutral = variant("neutral");
