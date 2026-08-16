/*
 * Loads the real index.html + real ES modules against the DOM stub and feeds a
 * real /api/status snapshot through, verifying the dashboard populates.
 * This is the closest thing to "open the page" without a headless browser.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JS = pathToFileURL(path.join(ROOT, "public", "js")).href;

// Discover every id present in the real HTML so the stub matches the page.
const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const idsInHtml = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);

class Node {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.parentNode = null; this.attributes = {};
    this.style = {}; this.dataset = {}; this._class = ""; this._text = "";
    this.listeners = {}; this.disabled = false;
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
    this.classList = {
      add: c => { if (!this._class.split(" ").includes(c)) this._class = (this._class + " " + c).trim(); },
      remove: c => { this._class = this._class.split(" ").filter(x => x && x !== c).join(" "); },
      replace: (a, b) => { this._class = this._class.split(" ").map(x => x === a ? b : x).join(" "); },
      contains: c => this._class.split(" ").includes(c)
    };
  }
  get className() { return this._class; }
  set className(v) { this._class = v; }
  get firstChild() { return this.children[0] || null; }
  get textContent() {
    return this.children.length
      ? this.children.map(c => typeof c === "string" ? c : c.textContent).join("") : this._text;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get innerHTML() { return this._html || ""; }
  append(...k) { for (const x of k) this.appendChild(x); }
  appendChild(k) {
    if (typeof k === "string") { this.children.push(k); return k; }
    if (k.tagName === "FRAGMENT") { for (const c of k.children.slice()) this.appendChild(c); k.children = []; return k; }
    k.parentNode = this; this.children.push(k); return k;
  }
  removeChild(k) { this.children = this.children.filter(c => c !== k); return k; }
  remove() { this.parentNode?.removeChild(this); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t, e = {}) { for (const fn of this.listeners[t] || []) fn(e); }
  querySelectorAll(sel) {
    const want = sel.replace(".", ""); const out = [];
    const walk = n => { for (const c of n.children) { if (typeof c === "string") continue; if (c._class.split(" ").includes(want)) out.push(c); walk(c); } };
    walk(this); return out;
  }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
}

const ids = new Map();
for (const id of idsInHtml) { const n = new Node(); n.id = id; ids.set(id, n); }
// hashrate has a text node + unit span in the real markup
// hashrate is now its own span in the markup

globalThis.document = {
  hidden: false,
  getElementById: id => ids.get(id) ?? null,
  createElement: t => new Node(t),
  createDocumentFragment: () => new Node("fragment"),
  addEventListener() {}
};
globalThis.requestAnimationFrame = fn => fn();
globalThis.sessionStorage = { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, v); } };
globalThis.EventSource = class { static CLOSED = 2; constructor() { this.readyState = 1; } addEventListener() {} close() { this.readyState = 2; } };
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true });

// Serve a real snapshot captured from the running server.
const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "snapshot.json"), "utf8"));
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => snapshot, clone() { return this; } });

await import(`${JS}/app.js`);
await new Promise(r => setTimeout(r, 60));

const t = id => ids.get(id).textContent;
console.log("  rendered values");
for (const id of ["status", "host", "accepted", "ratio", "rejected", "difficulty", "walletAddress", "uptime", "logCount"]) {
  console.log(`    ${id.padEnd(14)} ${JSON.stringify(t(id))}`);
}
console.log(`    ${"hashrate".padEnd(14)} ${JSON.stringify(t("hashrate"))}`);
console.log(`    ${"gpu cards".padEnd(14)} ${ids.get("gpus").children.length}`);
console.log(`    ${"log rows".padEnd(14)} ${ids.get("logLines").children.length}`);

assert.strictEqual(t("status"), snapshot.mining.status, "status must render");
assert.ok(t("host").includes(snapshot.host.hostname), "hostname must render");
assert.ok(t("hashrate").includes(snapshot.mining.hashrateKHs.toFixed(2)), "hashrate must render");
assert.strictEqual(ids.get("gpus").children.length, snapshot.gpu.length, "one card per GPU");
assert.ok(ids.get("logLines").children.length > 0, "console must have rows");
assert.ok(t("walletAddress") === snapshot.miner.wallet, "wallet must render");

// GPU card content
const card = ids.get("gpus").children[0].textContent;
assert.ok(card.includes("RTX"), "GPU name in card");
assert.ok(card.includes("64"), "temperature in card");
console.log("\n  \u2713 dashboard populated correctly from a real snapshot\n");

process.exit(0);
