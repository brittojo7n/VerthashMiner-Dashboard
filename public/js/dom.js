/** Minimal DOM helpers that avoid redundant reads and writes. */

/** Element lookup cache: `getElementById` is called once per id, not per frame. */
const cache = new Map();

export function el(id) {
  let node = cache.get(id);
  if (node === undefined) {
    node = document.getElementById(id);
    cache.set(id, node);
  }
  return node;
}

/** Forget cached nodes that were replaced (e.g. rebuilt GPU cards). */
export function forget(prefix) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** Write text only when it differs, so the browser skips needless layout. */
export function text(node, value) {
  if (!node) return;
  const next = String(value);
  if (node.textContent !== next) node.textContent = next;
}

/** Same guard for class names. */
export function className(node, value) {
  if (node && node.className !== value) node.className = value;
}

/** Same guard for inline style properties. */
export function style(node, prop, value) {
  if (node && node.style[prop] !== value) node.style[prop] = value;
}

/** Create an element with optional class and text in one call. */
export function make(tag, cls, content) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (content != null) node.textContent = content;
  return node;
}
