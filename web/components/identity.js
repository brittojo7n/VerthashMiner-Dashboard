import { make, text } from "../lib/dom.js";
import { DASH } from "../lib/present.js";
import { parseMinerUser, minerUserSource } from "../lib/user.js";

const COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

function writeClipboard(value) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    return navigator.clipboard.writeText(value);
  }
  return new Promise((resolve, reject) => {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    try {
      if (!document.execCommand("copy")) throw new Error("copy");
      resolve();
    } catch (err) {
      reject(err);
    } finally {
      area.remove();
    }
  });
}

function field(labelText) {
  const row = make("div", "identity-field");
  const label = make("span", "identity-label", labelText);
  const value = make("span", "identity-value");
  row.append(label, value);
  return { row, value };
}

export function createIdentity() {
  const node = make("div", "identity");
  const wallet = field("Wallet");
  const copyBtn = make("button", "identity-copy");
  copyBtn.type = "button";
  copyBtn.title = "Copy wallet address";
  copyBtn.setAttribute("aria-label", "Copy wallet address");
  copyBtn.innerHTML = COPY_SVG;
  wallet.row.appendChild(copyBtn);
  const worker = field("Worker");
  worker.row.hidden = true;
  node.append(wallet.row, worker.row);

  let address = "";
  let copiedTimer = 0;

  function markCopied(on) {
    copyBtn.classList.toggle("copied", on);
    copyBtn.innerHTML = on ? CHECK_SVG : COPY_SVG;
    copyBtn.title = on ? "Copied" : "Copy wallet address";
  }

  copyBtn.addEventListener("click", async () => {
    if (!address) return;
    try {
      await writeClipboard(address);
      markCopied(true);
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => markCopied(false), 1600);
    } catch {
      markCopied(false);
    }
  });

  return {
    node,
    set(next = {}) {
      const parsed = typeof next === "string"
        ? parseMinerUser(next)
        : parseMinerUser(next.user || minerUserSource(next));
      address = parsed.wallet || "";
      text(wallet.value, address || DASH);
      wallet.value.title = address;
      copyBtn.disabled = !address;
      if (parsed.worker) {
        text(worker.value, parsed.worker);
        worker.value.title = parsed.worker;
        worker.row.hidden = false;
      } else {
        text(worker.value, "");
        worker.value.title = "";
        worker.row.hidden = true;
      }
      return this;
    }
  };
}
