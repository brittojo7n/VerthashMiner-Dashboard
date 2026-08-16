const cache = new Map();

export function el(id) {
  let node = cache.get(id);
  if (node === undefined) {
    node = document.getElementById(id);
    cache.set(id, node);
  }
  return node;
}

export function text(node, value) {
  if (!node) return;
  const next = String(value);
  if (node.textContent !== next) node.textContent = next;
}

export function className(node, value) {
  if (node && node.className !== value) node.className = value;
}

export function style(node, prop, value) {
  if (node && node.style[prop] !== value) node.style[prop] = value;
}

export function make(tag, cls, content) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (content != null) node.textContent = content;
  return node;
}
