import { make, text } from "./dom.js";
import { isLite } from "./perf.js";

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

const MAX_ROWS_LITE = 60;
const MAX_ROWS = 200;
const MAX_HIGHLIGHT_CHARS = 512;

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
  let rendered = 0;
  let scrollQueued = false;

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

  const reset = () => {
    lines.innerHTML = EMPTY_HTML;
    maxId = 0;
    rendered = 0;
  };

  return {
    get autoScroll() { return autoScroll; },
    set autoScroll(value) {
      autoScroll = value;
      if (value) scrollToBottom();
    },

    render(entries, meta = {}) {
      const count = Number.isFinite(meta.count) ? meta.count : (entries || []).length;
      const capacity = Number.isFinite(meta.capacity) ? meta.capacity : count;

      // Server restart detection: the log sequence starts over, so stale ids
      // held by this tab would silently swallow every new line.
      if (Number.isFinite(meta.seq) && meta.seq < maxId) reset();

      if (count === 0) {
        if (maxId !== 0) reset();
        text(counter, "0 logs");
        return;
      }

      text(counter, `${count} log${count === 1 ? "" : "s"}`);

      if (!entries || entries.length === 0) return;
      if (maxId === 0) {
        lines.textContent = "";
        rendered = 0;
      }

      const keep = Math.min(Math.max(capacity, count), isLite() ? MAX_ROWS_LITE : MAX_ROWS);
      const frag = document.createDocumentFragment();
      let added = 0;

      for (const entry of entries) {
        if (!entry || entry.id <= maxId) continue;
        const row = make("div", `log-entry log-type-${entry.type || "info"}`);
        row.innerHTML = `<span class="log-prompt">&gt;</span><span class="log-msg">${highlight(entry.text)}</span>`;
        frag.appendChild(row);
        maxId = entry.id;
        added++;
      }

      if (!added) return;

      lines.appendChild(frag);
      rendered += added;

      while (rendered > keep && lines.firstChild) {
        lines.removeChild(lines.firstChild);
        rendered--;
      }

      if (autoScroll) scrollToBottom();
    }
  };
}
