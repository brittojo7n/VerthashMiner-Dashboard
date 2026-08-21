const cache = new Map();
const set = (node, prop, value) => { if (node && node[prop] !== value) node[prop] = value; };
export function el(id) {
  let node = cache.get(id);
  if (node === undefined) { node = document.getElementById(id); cache.set(id, node); }
  return node;
}
export function text(node, value) { set(node, "textContent", String(value)); }
export function className(node, value) { set(node, "className", value); }
export function style(node, prop, value) { if (node) set(node.style, prop, value); }
export function make(tag, cls, content) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (content != null) node.textContent = content;
  return node;
}
