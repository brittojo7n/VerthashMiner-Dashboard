/*
 * Client module tests.
 *
 * Runs the browser ES modules under Node against a minimal DOM stub. This
 * catches import errors, typos and render regressions without a headless
 * browser or any dependency.
 *
 *   node test/client.mjs
 */
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = pathToFileURL(path.join(HERE, "..", "public", "js")).href;

// ── DOM stub ────────────────────────────────────────────────────────────────
class Node {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this._class = "";
    this._text = "";
    this.listeners = {};
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
    this.disabled = false;
    this.classList = {
      add: c => { if (!this._class.split(" ").includes(c)) this._class = (this._class + " " + c).trim(); },
      remove: c => { this._class = this._class.split(" ").filter(x => x && x !== c).join(" "); },
      replace: (a, b) => { this._class = this._class.split(" ").map(x => (x === a ? b : x)).join(" "); },
      contains: c => this._class.split(" ").includes(c)
    };
  }
  get className() { return this._class; }
  set className(v) { this._class = v; }
  get firstChild() { return this.children[0] || null; }
  get textContent() {
    return this.children.length
      ? this.children.map(c => (typeof c === "string" ? c : c.textContent)).join("")
      : this._text;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get innerHTML() { return this._html || ""; }
  clear() { for (const c of this.children) if (typeof c !== "string") c.parentNode = null; this.children = []; }
  append(...kids) { for (const k of kids) this.appendChild(k); }
  appendChild(k) {
    if (typeof k === "string") { this.children.push(k); return k; }
    // A real DocumentFragment inserts its children, not itself.
    if (k.tagName === "FRAGMENT") {
      for (const child of k.children.slice()) this.appendChild(child);
      k.children = [];
      return k;
    }
    k.parentNode = this; this.children.push(k); return k;
  }
  removeChild(k) { this.children = this.children.filter(c => c !== k); return k; }
  remove() { this.parentNode?.removeChild(this); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, ev = {}) { for (const fn of this.listeners[type] || []) fn(ev); }
  querySelectorAll(sel) {
    const want = sel.replace(".", "");
    const out = [];
    const walk = n => {
      for (const c of n.children) {
        if (typeof c === "string") continue;
        if (c._class.split(" ").includes(want)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

const ids = new Map();
const byId = id => {
  if (!ids.has(id)) { const n = new Node(); n.id = id; ids.set(id, n); }
  return ids.get(id);
};

for (const id of [
  "toastStack", "dot", "status", "host", "btnAction", "btnRestart", "error", "gpus",
  "localTime", "authModal", "authInput", "authError", "authSubmit", "btnAutoScroll",
  "btnCopyLogs", "terminal", "logLines", "logCount", "uptime", "sharesPerMinute",
  "hashrate", "accepted", "ratio", "rejected", "difficulty", "lastAccepted",
  "walletAddress", "confirmModal", "confirmTitle", "confirmDesc", "confirmYes", "confirmCancel"
]) byId(id);

globalThis.document = {
  hidden: false,
  getElementById: id => (ids.has(id) ? ids.get(id) : null),
  createElement: tag => new Node(tag),
  createDocumentFragment: () => new Node("fragment"),
  addEventListener() {}
};
globalThis.requestAnimationFrame = fn => fn();
globalThis.sessionStorage = {
  store: new Map(),
  getItem(k) { return this.store.get(k) ?? null; },
  setItem(k, v) { this.store.set(k, v); }
};
globalThis.EventSource = class {
  static CLOSED = 2;
  constructor() { this.readyState = 0; }
  addEventListener() {} close() { this.readyState = 2; }
};
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
// `navigator` is a getter-only global in modern Node.
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true
});

// ── harness ─────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const results = [];
async function test(group, name, fn) {
  try { await fn(); pass++; results.push([group, name, null]); }
  catch (e) { fail++; results.push([group, name, e.message]); }
}

// ── format ──────────────────────────────────────────────────────────────────
const fmt = await import(`${JS}/format.js`);

await test("format", "num formats and guards non-finite input", () => {
  assert.strictEqual(fmt.num(12.345, 2), "12.35");
  assert.strictEqual(fmt.num(null), "\u2014");
  assert.strictEqual(fmt.num(NaN), "\u2014");
  assert.strictEqual(fmt.num(Infinity), "\u2014");
});
await test("format", "uptime switches to day form past 24h", () => {
  assert.strictEqual(fmt.uptime(0), "00:00:00");
  assert.strictEqual(fmt.uptime(3661), "01:01:01");
  assert.strictEqual(fmt.uptime(90061), "1d 1h 1m");
  assert.strictEqual(fmt.uptime(-5), "00:00:00");
});
await test("format", "timestamp renders and appends timezone", () => {
  const ms = new Date(2026, 0, 2, 3, 4, 5).getTime();
  assert.strictEqual(fmt.timestamp(ms), "2026-01-02 03:04:05");
  assert.strictEqual(fmt.timestamp(ms, "UTC+05:30"), "2026-01-02 03:04:05 (UTC+05:30)");
});
await test("format", "tempClass thresholds", () => {
  assert.strictEqual(fmt.tempClass(60), "green");
  assert.strictEqual(fmt.tempClass(75), "yellow");
  assert.strictEqual(fmt.tempClass(85), "red");
  assert.strictEqual(fmt.tempClass(null), "");
});
await test("format", "stripLogPrefix removes the applog header", () => {
  assert.strictEqual(
    fmt.stripLogPrefix("[2026-08-17 12:00:00] ERROR CUDA error: out of memory"),
    "CUDA error: out of memory");
});

// ── dom ─────────────────────────────────────────────────────────────────────
const dom = await import(`${JS}/dom.js`);

await test("dom", "el caches lookups", () => {
  assert.strictEqual(dom.el("status"), dom.el("status"));
});
await test("dom", "text writes only on change", () => {
  const n = new Node();
  dom.text(n, "a");
  assert.strictEqual(n.textContent, "a");
  dom.text(n, "a");
  dom.text(n, "b");
  assert.strictEqual(n.textContent, "b");
});
await test("dom", "make builds class and content in one call", () => {
  const n = dom.make("span", "x", "hi");
  assert.strictEqual(n.tagName, "SPAN");
  assert.strictEqual(n.className, "x");
  assert.strictEqual(n.textContent, "hi");
});

// ── toast ───────────────────────────────────────────────────────────────────
const toast = await import(`${JS}/toast.js`);
const stack = byId("toastStack");

await test("toast", "variants map to the themed classes", () => {
  stack.clear();
  toast.info("I", "m", "k-info");
  toast.warn("W", "m", "k-warn");
  toast.error("E", "m", "k-error");
  toast.success("S", "m", "k-success");
  const classes = stack.children.map(c => c.className);
  assert.ok(classes.some(c => c.includes("toast-info")));
  assert.ok(classes.some(c => c.includes("toast-warn")));
  assert.ok(classes.some(c => c.includes("toast-error")));
  assert.ok(classes.some(c => c.includes("toast-success")));
});
await test("toast", "same key updates in place instead of stacking", () => {
  stack.clear();
  toast.warn("First", "one", "dupe");
  toast.warn("Second", "two", "dupe");
  assert.strictEqual(stack.children.length, 1);
  assert.ok(stack.children[0].textContent.includes("Second"));
});
await test("toast", "stack is bounded", () => {
  stack.clear();
  for (let i = 0; i < 10; i++) toast.info("T" + i, "m", "key" + i);
  assert.ok(stack.children.length <= 4, `expected <=4, got ${stack.children.length}`);
});
await test("toast", "content is set as text, never markup", () => {
  stack.clear();
  toast.error("XSS", "<img src=x onerror=alert(1)>", "xss");
  const msg = stack.children[0].querySelector(".toast-msg");
  assert.strictEqual(msg.textContent, "<img src=x onerror=alert(1)>");
  assert.strictEqual(msg.innerHTML, "");
});

// ── gpu view ────────────────────────────────────────────────────────────────
const gpuView = await import(`${JS}/gpu.js`);
const gpuBox = byId("gpus");
const sampleGpu = (i, over = {}) => ({
  index: i, name: "RTX 3070", temperatureC: 64, powerW: 120, utilizationPct: 98,
  coreMHz: 1800, memoryMHz: 7000, memoryUsedMB: 512, memoryTotalMB: 8192,
  pstate: "P2", pciBusId: "01:00:0", hashrate: 12.34, ...over
});

await test("gpu", "renders one card per device", () => {
  gpuView.render(gpuBox, [sampleGpu(0), sampleGpu(1)], "");
  assert.strictEqual(gpuBox.children.length, 2);
});
await test("gpu", "reuses cards across refreshes", () => {
  gpuView.render(gpuBox, [sampleGpu(0), sampleGpu(1)], "");
  const first = gpuBox.children[0];
  gpuView.render(gpuBox, [sampleGpu(0, { temperatureC: 70 }), sampleGpu(1)], "");
  assert.strictEqual(gpuBox.children[0], first, "card node must be retained");
});
await test("gpu", "shows a diagnostic when nvidia-smi is missing", () => {
  gpuView.render(gpuBox, [], "spawn nvidia-smi.exe ENOENT");
  assert.ok(gpuBox.textContent.includes("nvidia-smi could not be found"));
});
await test("gpu", "shows a neutral message before first telemetry", () => {
  gpuView.render(gpuBox, [], "");
  assert.ok(gpuBox.textContent.includes("Waiting for GPU telemetry"));
});
await test("gpu", "renders hashrate and efficiency", () => {
  gpuView.render(gpuBox, [sampleGpu(0)], "");
  const t = gpuBox.textContent;
  assert.ok(t.includes("12.34"), "hashrate shown");
  assert.ok(t.includes("0.10"), "efficiency 12.34/120 shown");
});

// ── console ─────────────────────────────────────────────────────────────────
const { createConsole } = await import(`${JS}/console.js`);
const view = createConsole({
  terminal: byId("terminal"), lines: byId("logLines"), counter: byId("logCount")
});

await test("console", "appends only new ids", () => {
  const lines = byId("logLines");
  view.render([{ id: 1, text: "one", type: "info" }]);
  assert.strictEqual(lines.children.length, 1);
  view.render([{ id: 1, text: "one", type: "info" }, { id: 2, text: "two", type: "info" }]);
  assert.strictEqual(lines.children.length, 2);
});
await test("console", "escapes markup before highlighting", () => {
  const lines = byId("logLines");
  lines.clear();
  view.render([{ id: 99, text: "<script>alert(1)</script>", type: "info" }]);
  const html = lines.children[0].innerHTML;
  assert.ok(html.includes("&lt;script&gt;"), "must be escaped");
  assert.ok(!html.includes("<script>"), "raw tag must not survive");
});
await test("console", "counter reflects entry count", () => {
  view.render([{ id: 200, text: "a", type: "info" }, { id: 201, text: "b", type: "info" }]);
  assert.ok(byId("logCount").textContent.includes("2 log"));
});

// ── report ──────────────────────────────────────────────────────────────────
let group = "";
for (const [g, name, err] of results) {
  if (g !== group) { group = g; console.log(`\n  ${g}`); }
  console.log(err ? `    \u2717 ${name}\n        ${err}` : `    \u2713 ${name}`);
}
console.log(`\n  ${pass} passing, ${fail} failing\n`);
process.exit(fail ? 1 : 0);
