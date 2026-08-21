"use strict";

function parseSpecs(raw) {
  return raw.split(",").map(s => s.trim()).filter(Boolean).map(spec => {
    const m = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(spec);
    return m ? { local: m[1], exported: m[2] } : { local: spec, exported: spec };
  });
}

function importsOf(src) {
  const ids = [];
  for (const re of [
    /import\s+["']\.\/([\w-]+)\.js["']/g,
    /import\s+\*\s*as\s+[A-Za-z_$][\w$]*\s+from\s+["']\.\/([\w-]+)\.js["']/g,
    /import\s+\{[^}]*\}\s+from\s+["']\.\/([\w-]+)\.js["']/g
  ]) {
    for (const m of src.matchAll(re)) ids.push(m[1]);
  }
  return ids;
}

function transformModule(src) {
  const exportMap = [];
  let out = src;
  out = out.replace(/^[ \t]*import\s+["']\.\/([\w-]+)\.js["'];?[ \t]*$/gm, (m, id) => `__require("${id}");`);
  out = out.replace(/^[ \t]*import\s+\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s+["']\.\/([\w-]+)\.js["'];?[ \t]*$/gm, (m, ns, id) => `const ${ns} = __require("${id}");`);
  out = out.replace(/^[ \t]*import\s+\{([^}]*)\}\s+from\s+["']\.\/([\w-]+)\.js["'];?[ \t]*$/gm, (m, raw, id) => {
    const specs = parseSpecs(raw).map(s => (s.local === s.exported ? s.local : `${s.local}: ${s.exported}`)).join(", ");
    return `const { ${specs} } = __require("${id}");`;
  });
  out = out.replace(/^[ \t]*export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)\b/gm, (m, asy, name) => { exportMap.push({ local: name, exported: name }); return `${asy || ""}function ${name}`; });
  out = out.replace(/^[ \t]*export\s+class\s+([A-Za-z_$][\w$]*)\b/gm, (m, name) => { exportMap.push({ local: name, exported: name }); return `class ${name}`; });
  out = out.replace(/^[ \t]*export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)\b/gm, (m, kind, name) => { exportMap.push({ local: name, exported: name }); return `${kind} ${name}`; });
  out = out.replace(/^[ \t]*export\s+\{([^}]*)\}\s*;?[ \t]*$/gm, (m, raw) => { for (const s of parseSpecs(raw)) exportMap.push(s); return ""; });
  return { body: out, exportMap };
}

function bundleModules(read) {
  const modules = {};
  const order = [];
  const queue = ["app"];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const src = read(id);
    modules[id] = src;
    order.push(id);
    for (const dep of importsOf(src)) if (!seen.has(dep)) queue.push(dep);
  }
  const lines = [
    '"use strict";',
    "(() => {",
    "const __mods = {};",
    "const __cache = {};",
    "const __register = (id, fn) => { __mods[id] = fn; };",
    "const __assign = (target, source) => Object.assign(target, source);",
    "const __require = id => { if (__cache[id]) return __cache[id]; const exports = {}; __mods[id](__require, exports); __cache[id] = exports; return exports; };"
  ];
  for (const id of order) {
    const { body, exportMap } = transformModule(modules[id]);
    lines.push(`__register("${id}", (__require, __exports) => {`);
    lines.push(body);
    if (exportMap.length) lines.push(`__assign(__exports, { ${exportMap.map(e => `${e.exported}: ${e.local}`).join(", ")} });`);
    lines.push("});");
  }
  lines.push('__require("app");');
  lines.push("})();");
  return lines.join("\n");
}

module.exports = { bundleModules, transformModule, importsOf };
