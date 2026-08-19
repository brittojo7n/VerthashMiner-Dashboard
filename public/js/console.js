import { make, text } from "./dom.js";
import * as cache from "./logcache.js";

const RULES = [
  [/(\b[\d.]+\s*(?:kH|MH|GH|TH)\/s\b)/gi, "hl-hash"],
  [/(\baccepted:\s*\d+\s*\/\s*\d+(?:\s*\([\d.]*%\))?)/gi, "hl-acc"],
  [/(\bdifficulty(?:\s*(?:set|is))?\s*(?:to|:)?\s*[\d.]+\b)/gi, "hl-diff"],
  [/(\b(?:errors?|err):\s*0\b)/gi, "hl-acc"],
  [/(\bwarnings?:\s*0\b)/gi, "hl-acc"],
  [/(\b(?:errors?|err):\s*[1-9]\d*\b)/gi, "hl-err"],
  [
    /(\b(?:cuda\s+error|fatal\s+error|connection\s+failed|connection\s+refused|out\s+of\s+memory|failed\s+to\s+\w+|exception|enoent|rejected\s+share)\b[^\n<]*)/gi,
    "hl-err"
  ],
  [/\b(INFO)\b/g, "hl-info"],
  [/\b(DEBUG)\b/g, "hl-debug"],
  [/\b(WARN(?:ING)?)\b/g, "hl-warn"],
  [/\b(ERROR|FATAL)\b/g, "hl-err"],
  [/^(\[(?:SYSTEM|WARN|ERROR|INFO|DEBUG)\])/g, "hl-tag"]
];

const MAX_LINES = cache.MAX_ENTRIES;
const MAX_HIGHLIGHT_CHARS = 512;
const PERSIST_DELAY_MS = 2000;

const ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, ch => ESCAPE[ch]);
}

function highlight(raw) {
  const escaped = escapeHtml(String(raw));
  if (escaped.length > MAX_HIGHLIGHT_CHARS) return escaped;
  let painted = escaped;
  for (let i = 0; i < RULES.length; i++) {
    painted = painted.replace(RULES[i][0], `<span class="${RULES[i][1]}">$1</span>`);
  }
  return painted;
}

const EMPTY_HTML =
  '<div class="log-empty"><span class="log-prompt">&gt;</span>' +
  '<span class="log-text">VerthashMiner console initialized. Waiting for miner output...</span>' +
  '<span class="term-cursor">_</span></div>';

export function createConsole({ terminal, lines, counter, onAutoScrollChange }) {
  let autoScroll = true;
  let maxId = 0;
  let history = [];
  let scrollQueued = false;
  let persistTimer = null;

  const scrollToBottom = () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      terminal.scrollTop = terminal.scrollHeight;
    });
  };

  terminal.addEventListener(
    "scroll",
    () => {
      const atBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 25;
      if (atBottom !== autoScroll) {
        autoScroll = atBottom;
        onAutoScrollChange?.(autoScroll);
      }
    },
    { passive: true }
  );

  const updateCounter = () =>
    text(counter, `${history.length} log${history.length === 1 ? "" : "s"}`);

  const persistNow = () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    cache.save(history);
  };

  const persistSoon = () => {
    if (persistTimer || !cache.usable()) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      cache.save(history);
    }, PERSIST_DELAY_MS);
  };

window.addEventListener("pagehide", persistNow);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) persistNow();
  });

  const buildRow = entry => {
    const row = make("div", `log-entry log-type-${entry.type || "info"}`);
    row.dataset.id = entry.id;
    row.innerHTML = `<span class="log-prompt">&gt;</span><span class="log-msg">${highlight(entry.text)}</span>`;
    return row;
  };

  const reset = clearStorage => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    lines.innerHTML = EMPTY_HTML;
    maxId = 0;
    history = [];
    if (clearStorage) cache.clear();
    updateCounter();
  };

const restored = cache.load();
  if (restored.length) {
    const frag = document.createDocumentFragment();
    for (const entry of restored) {
      frag.appendChild(buildRow(entry));
      maxId = entry.id;
    }
    lines.textContent = "";
    lines.appendChild(frag);
    history = restored;
    updateCounter();
    scrollToBottom();
  }

  return {
    get autoScroll() { return autoScroll; },
    set autoScroll(value) {
      autoScroll = value;
      if (value) scrollToBottom();
    },

    render(entries, meta = {}) {
      try {
        const serverCount = Number.isFinite(meta.count) ? meta.count : (entries || []).length;

if (Number.isFinite(meta.seq) && meta.seq < maxId) reset(true);

        if (serverCount === 0) {
          if (maxId !== 0) reset(true);
          else updateCounter();
          return;
        }

        if (!entries || entries.length === 0) {
          updateCounter();
          return;
        }

        if (maxId === 0 && history.length === 0) lines.textContent = "";

        const frag = document.createDocumentFragment();
        let added = 0;

        for (const entry of entries) {
          if (!entry || typeof entry.id !== "number" || entry.id <= maxId) continue;
          frag.appendChild(buildRow(entry));
          history.push({ id: entry.id, text: String(entry.text), type: entry.type });
          maxId = entry.id;
          added++;
        }

        if (!added) {
          updateCounter();
          return;
        }

        lines.appendChild(frag);

while (history.length > MAX_LINES && lines.firstChild) {
          lines.removeChild(lines.firstChild);
          history.shift();
        }

        updateCounter();
        persistSoon();
        if (autoScroll) scrollToBottom();
      } catch (err) {
      try { console.error("[dashboard] console render failed", err); } catch { }
      }
    }
  };
}
