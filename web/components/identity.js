import { make, text } from "../lib/dom.js";
import { DASH } from "../lib/present.js";
import { parseMinerUser, minerUserSource } from "../lib/user.js";
import * as toast from "./toast.js";

const COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

function writeClipboard(value) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(value);
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

export function createIdentity() {
  const node = make("div", "identity");
  const walletRow = make("div", "identity-row");
  const walletLabel = make("span", "identity-label", "Wallet");
  const walletValue = make("span", "identity-value");
  walletValue.title = "";
  const copyBtn = make("button", "identity-copy");
  copyBtn.type = "button";
  copyBtn.title = "Copy wallet address";
  copyBtn.setAttribute("aria-label", "Copy wallet address");
  copyBtn.innerHTML = COPY_SVG;
  walletRow.append(walletLabel, walletValue, copyBtn);

  const workerRow = make("div", "identity-row identity-worker");
  workerRow.hidden = true;
  const workerLabel = make("span", "identity-label", "Worker");
  const workerValue = make("span", "identity-value identity-worker-value");
  workerRow.append(workerLabel, workerValue);

  node.append(walletRow, workerRow);

  let wallet = "";
  let copiedTimer = 0;

  function markCopied(on) {
    copyBtn.classList.toggle("copied", on);
    copyBtn.innerHTML = on ? CHECK_SVG : COPY_SVG;
    copyBtn.title = on ? "Copied" : "Copy wallet address";
  }

  copyBtn.addEventListener("click", async () => {
    if (!wallet) return;
    try {
      await writeClipboard(wallet);
      markCopied(true);
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => markCopied(false), 1600);
      toast.success("Wallet Copied", "Address copied to clipboard.", "wallet-copy");
    } catch {
      toast.error("Copy Failed", "Could not copy the wallet address.", "wallet-copy");
    }
  });

  return {
    node,
    set(next = {}) {
      const parsed = typeof next === "string"
        ? parseMinerUser(next)
        : parseMinerUser(minerUserSource(next));
      wallet = parsed.wallet || "";
      const shown = wallet || DASH;
      text(walletValue, shown);
      walletValue.title = wallet;
      copyBtn.disabled = !wallet;
      if (parsed.worker) {
        text(workerValue, parsed.worker);
        workerRow.hidden = false;
      } else {
        text(workerValue, "");
        workerRow.hidden = true;
      }
      return this;
    }
  };
}
