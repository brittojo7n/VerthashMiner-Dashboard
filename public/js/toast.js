import { el, make } from "./dom.js";

/**
 * Bottom-right notifications.
 *
 * Variants map to CSS classes that only re-point a `--toast-rgb` custom
 * property, so colours live in style.css and are never duplicated here:
 *   info    blue    miner lifecycle (starting / stopping / restarting)
 *   warn    orange  rate limiting and other recoverable pressure
 *   error   red     failures
 *   success green   confirmations
 */

const DEFAULT_MS = 3000;
const MAX_VISIBLE = 4;
const ICONS = { info: "i", warn: "!", error: "\u00d7", success: "\u2713" };

const live = new Map();
let stack = null;

const container = () => (stack ||= el("toastStack"));

/**
 * Remove a toast. Fades out by default; `immediate` detaches synchronously so
 * an over-capacity stack can never be visible, even for one frame.
 */
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
  setTimeout(remove, 400); // Fallback when transitions are disabled.
}

/**
 * Show (or refresh) a toast. Re-firing an existing `key` updates it in place so
 * repeated events never stack duplicates.
 */
export function show({ key, title, message, variant = "info", duration = DEFAULT_MS }) {
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

  // Bound the stack so a runaway loop cannot fill the screen. Evicting
  // synchronously keeps the visible count at MAX_VISIBLE even during a burst,
  // where a fade-out would briefly overflow.
  while (live.size >= MAX_VISIBLE) dismiss(live.keys().next().value, true);

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
    node, icon, title: titleEl, message: messageEl,
    timer: setTimeout(() => dismiss(id), duration)
  });
}

const variant = name => (title, message, key) => show({ key, title, message, variant: name });

export const info = variant("info");
export const warn = variant("warn");
export const error = variant("error");
export const success = variant("success");
