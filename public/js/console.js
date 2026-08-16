import { make, text } from "./dom.js";

const RULES = [
  [/(\b[\d.]+\s*(?:kH|MH|GH|TH)\/s\b)/gi, "hl-hash"],
  [/(\baccepted:\s*\d+\s*\/\s*\d+(?:\s*\([\d.]*%\))?)/gi, "hl-acc"],
  [/(\bdifficulty(?:\s*(?:set|is))?\s*(?:to|:)?\s*[\d.]+\b)/gi, "hl-diff"],
  [/(\b(?:errors?|err):\s*0\b)/gi, "hl-acc"],
  [/(\bwarnings?:\s*0\b)/gi, "hl-acc"],
  [/(\b(?:errors?|err):\s*[1-9]\d*\b)/gi, "hl-err"],
  [/(\b(?:cuda\s+error|fatal\s+error|connection\s+failed|connection\s+refused|out\s+of\s+memory|failed\s+to\s+\w+|exception|enoent|rejected\s+share)\b[^\n<]*)/gi, "hl-err"],
  [/\b(INFO)\b/g, "hl-info"],
  [/\b(DEBUG)\b/g, "hl-debug"],
  [/\b(WARN(?:ING)?)\b/g, "hl-warn"],
  [/\b(ERROR|FATAL)\b/g, "hl-err"],
  [/^(\[(?:SYSTEM|WARN|ERROR|INFO|DEBUG)\])/g, "hl-tag"]
];

const ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };

function highlight(raw) {
  let out = String(raw).replace(/[&<>"']/g, ch => ESCAPE[ch]);
  for (const [pattern, cls] of RULES) {
    out = out.replace(pattern, `<span class="${cls}">$1</span>`);
  }
  return out;
}

const EMPTY_HTML =
  '<div class="log-empty"><span class="log-prompt">&gt;</span>' +
  '<span class="log-text">VerthashMiner console active. Waiting for miner output...</span>' +
  '<span class="term-cursor">_</span></div>';

export function createConsole({ terminal, lines, counter, onAutoScrollChange }) {
  let autoScroll = true;
  let maxId = 0;

  const scrollToBottom = () => {
    requestAnimationFrame(() => { terminal.scrollTop = terminal.scrollHeight; });
  };

  terminal.addEventListener("scroll", () => {
    const atBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 25;
    if (atBottom !== autoScroll) {
      autoScroll = atBottom;
      onAutoScrollChange?.(autoScroll);
    }
  }, { passive: true });

  return {
    get autoScroll() { return autoScroll; },
    set autoScroll(value) {
      autoScroll = value;
      if (value) scrollToBottom();
    },

    render(logs) {
      if (!logs || logs.length === 0) {
        if (maxId !== 0) {
          lines.innerHTML = EMPTY_HTML;
          maxId = 0;
        }
        text(counter, "0 logs");
        return;
      }

      text(counter, `${logs.length} log${logs.length === 1 ? "" : "s"}`);

      if (maxId === 0) lines.textContent = "";

      let added = 0;
      const frag = document.createDocumentFragment();
      for (const entry of logs) {
        if (entry.id <= maxId) continue;
        const row = make("div", `log-entry log-type-${entry.type || "info"}`);
        row.innerHTML =
          `<span class="log-prompt">&gt;</span><span class="log-msg">${highlight(entry.text)}</span>`;
        frag.appendChild(row);
        maxId = entry.id;
        added++;
      }
      if (!added) return;

      lines.appendChild(frag);

      while (lines.children.length > logs.length) lines.removeChild(lines.firstChild);
      if (autoScroll) scrollToBottom();
    }
  };
}
