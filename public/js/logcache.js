const KEY = "vmd:console";
const VERSION = 1;

export const MAX_ENTRIES = 1000;

const MAX_TEXT_LENGTH = 2048;

let usableFlag = null;
let broken = false;

export function usable() {
  if (broken) return false;
  if (usableFlag !== null) return usableFlag;
  try {
    const probe = "vmd:probe";
    window.sessionStorage.setItem(probe, "1");
    window.sessionStorage.removeItem(probe);
    usableFlag = true;
  } catch {
    usableFlag = false;
  }
  return usableFlag;
}

export function isReloadNavigation() {
  try {
    if (typeof performance !== "undefined") {
      if (typeof performance.getEntriesByType === "function") {
        const nav = performance.getEntriesByType("navigation");
        if (nav && nav.length) return nav[0].type === "reload";
      }
      if (performance.navigation) return performance.navigation.type === 1;
    }
  } catch {
  }
  return false;
}

export function clear() {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
  }
}

function sanitize(entries) {
  const clean = [];
  let lastId = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "number" || !Number.isFinite(entry.id)) continue;
    if (entry.id <= lastId || typeof entry.text !== "string") continue;
    clean.push({
      id: entry.id,
      text: entry.text.slice(0, MAX_TEXT_LENGTH),
      type: typeof entry.type === "string" ? entry.type : "info"
    });
    lastId = entry.id;
  }
  return clean.slice(-MAX_ENTRIES);
}

export function load() {
  if (!usable()) return [];
  if (isReloadNavigation()) {
    clear();
    return [];
  }
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== VERSION || !Array.isArray(parsed.entries)) {
      clear();
      return [];
    }
    return sanitize(parsed.entries);
  } catch {
    clear();
    return [];
  }
}

export function save(entries) {
  if (!usable() || !Array.isArray(entries)) return;
  try {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ v: VERSION, entries: entries.slice(-MAX_ENTRIES) })
    );
  } catch {
    broken = true;
    clear();
  }
}
