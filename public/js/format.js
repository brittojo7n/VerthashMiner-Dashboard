const DASH = "\u2014";

export const num = (value, digits = 1) =>
  value == null || !Number.isFinite(value) ? DASH : Number(value).toFixed(digits);

export function uptime(totalSeconds) {
  let s = Math.max(0, Math.floor(totalSeconds || 0));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return d > 0
    ? `${d}d ${h}h ${m}m`
    : `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

const pad = n => String(n).padStart(2, "0");

export function timestamp(ms, tz) {
  const d = new Date(ms);
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return tz ? `${base} (${tz})` : base;
}

export const tempClass = t => (t == null ? "" : t >= 80 ? "red" : t >= 72 ? "yellow" : "green");

export const stripLogPrefix = text => String(text).replace(/^\[[^\]]+\]\s*\w+\s*/, "");

export { DASH };
