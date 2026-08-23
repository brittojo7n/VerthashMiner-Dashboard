import { make } from "../lib/dom.js";

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])';

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
}

export function createModal() {
  const backdrop = make("div", "modal-backdrop");
  const dialog = make("div", "modal");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  let dismissable = false;
  let onClose = null;

  const close = () => {
    if (!backdrop.classList.contains("show")) return;
    backdrop.classList.remove("show");
    const cb = onClose;
    dismissable = false;
    onClose = null;
    dialog.textContent = "";
    document.removeEventListener("keydown", onKey);
    if (cb) cb();
  };

  const onKey = (e) => {
    if (e.key === "Escape") {
      if (dismissable) close();
      return;
    }
    if (e.key !== "Tab") return;
    const list = focusables(dialog);
    if (!list.length) return;
    const first = list[0], last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !dialog.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !dialog.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  backdrop.addEventListener("click", (e) => {
    if (dismissable && e.target === backdrop) close();
  });

  function open(content, opts = {}) {
    dismissable = opts.dismissable !== false;
    onClose = opts.onClose || null;
    dialog.textContent = "";
    dialog.appendChild(content);
    backdrop.classList.add("show");
    document.addEventListener("keydown", onKey);
    const target = focusables(dialog)[0];
    if (target) target.focus();
  }

  return {
    open,
    close,
    dialog,
    backdrop,
    get isOpen() {
      return backdrop.classList.contains("show");
    },
  };
}
