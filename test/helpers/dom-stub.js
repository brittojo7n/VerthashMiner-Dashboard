"use strict";

const http = require("node:http");
const { EventEmitter } = require("node:events");

/**
 * A deliberately small DOM/browser stub — just enough surface for the
 * dashboard's own modules to run under Node.
 *
 * It is not a browser and does not pretend to be one: there is no layout, no
 * CSS and no event loop semantics. What it does give us is a real execution of
 * `public/js/app.js` against real server payloads, which catches missing
 * element ids, broken imports, and exceptions thrown inside the render path.
 */

class StubElement {
  constructor(tag = "div", id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.className = "";
    this._text = "";
    this.innerHTML = "";
    this.style = {};
    this.disabled = false;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.classList = {
      _set: new Set(),
      add: name => this.classList._set.add(name),
      remove: name => this.classList._set.delete(name),
      replace: (a, b) => {
        this.classList._set.delete(a);
        this.classList._set.add(b);
      },
      contains: name => this.classList._set.has(name)
    };
  }

  get textContent() {
    return this._text;
  }
  set textContent(value) {
    this._text = String(value);
    if (value === "") this.children = [];
  }

  get firstChild() {
    return this.children[0] || null;
  }

  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }
  removeEventListener(type) {
    this.listeners.delete(type);
  }
  dispatch(type, event = {}) {
    const fn = this.listeners.get(type);
    if (fn) fn({ currentTarget: this, target: this, ...event });
  }
  appendChild(node) {
    // Document fragments splice their children in, exactly like the real DOM.
    if (node && node.tagName === "FRAGMENT") {
      for (const child of node.children) this.children.push(child);
      node.children = [];
      return node;
    }
    this.children.push(node);
    return node;
  }
  removeChild(node) {
    const at = this.children.indexOf(node);
    if (at !== -1) this.children.splice(at, 1);
    return node;
  }
  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === "string") this._text += node;
      else this.children.push(node);
    }
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  querySelectorAll() {
    return [];
  }
  focus() {}
  remove() {}
}

/** Minimal EventSource backed by a real HTTP request. */
function createEventSourceClass(origin) {
  return class StubEventSource extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;

    constructor(path) {
      super();
      this.readyState = 0;
      this.onerror = null;
      this._buffer = "";

      const url = new URL(path, origin);
      this._req = http.request(
        { hostname: url.hostname, port: url.port, path: url.pathname, agent: false },
        res => {
          this._res = res;
          if (res.statusCode !== 200) {
            res.resume();
            this.readyState = 2;
            this.onerror?.();
            return;
          }
          this.readyState = 1;
          res.setEncoding("utf8");
          res.on("data", chunk => this._consume(chunk));
          res.on("end", () => {
            this.readyState = 2;
            this.onerror?.();
          });
        }
      );
      this._req.on("error", () => {
        this.readyState = 2;
        this.onerror?.();
      });
      this._req.end();
    }

    _consume(chunk) {
      this._buffer += chunk;
      let sep;
      while ((sep = this._buffer.indexOf("\n\n")) !== -1) {
        const frame = this._buffer.slice(0, sep);
        this._buffer = this._buffer.slice(sep + 2);
        const type = /^event: (.+)$/m.exec(frame);
        const data = /^data: (.*)$/m.exec(frame);
        if (type && data) this.emit(type[1], { data: data[1] });
      }
    }

    addEventListener(type, fn) {
      this.on(type, fn);
    }
    close() {
      this.readyState = 2;
      try {
        this._req.destroy();
        this._res?.destroy();
      } catch {
        /* already closed */
      }
    }
  };
}

/**
 * Installs the stub globals and returns handles for inspection.
 * @param {string} origin server to talk to (for fetch and EventSource)
 */
function installDom(origin) {
  const nodes = new Map();
  const created = [];

  const document = {
    hidden: false,
    listeners: new Map(),
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new StubElement("div", id));
      return nodes.get(id);
    },
    createElement(tag) {
      const node = new StubElement(tag);
      created.push(node);
      return node;
    },
    createDocumentFragment() {
      return new StubElement("fragment");
    },
    addEventListener(type, fn) {
      document.listeners.set(type, fn);
    }
  };

  const saved = {
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    sessionStorage: globalThis.sessionStorage,
    EventSource: globalThis.EventSource
  };

  globalThis.document = document;
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.sessionStorage = {
    _data: new Map(),
    getItem(key) {
      return this._data.has(key) ? this._data.get(key) : null;
    },
    setItem(key, value) {
      this._data.set(key, String(value));
    }
  };
  globalThis.EventSource = createEventSourceClass(origin);

  return {
    document,
    nodes,
    /** Text currently displayed by an element id. */
    textOf: id => (nodes.get(id) ? nodes.get(id).textContent : undefined),
    /** Every console row rendered so far. */
    logRows: () => (nodes.get("logLines") ? nodes.get("logLines").children : []),
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    }
  };
}

module.exports = { installDom, StubElement };
