"use strict";

function parseSpecs(raw) {
  return raw.split(",").map(s => s.trim()).filter(Boolean).map(spec => {
    const m = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(spec);
    return m ? { local: m[1], exported: m[2] } : { local: spec, exported: spec };
  });
}

function dirOf(id) {
  const i = id.lastIndexOf("/");
  return i === -1 ? "" : id.slice(0, i);
}

function resolveSpec(dir, spec) {
  const clean = spec.replace(/\.js$/, "");
  const base = dir ? dir.split("/") : [];
  for (const part of clean.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return base.join("/");
}

function parseImports(src) {
  const deps = [];
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    let m;
    if ((m = /^import\s+["']([^"']+)["'];?\s*$/.exec(line))) deps.push({ form: "side", spec: m[1] });
    else if ((m = /^import\s+\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["'];?\s*$/.exec(line))) deps.push({ form: "namespace", local: m[1], spec: m[2] });
    else if ((m = /^import\s+\{([^}]*)\}\s+from\s+["']([^"']+)["'];?\s*$/.exec(line))) deps.push({ form: "named", raw: m[1], spec: m[2] });
  }
  return deps;
}

function dependencyIds(src, dir) {
  return parseImports(src).map(d => resolveSpec(dir, d.spec));
}

function transformExport(line, exportMap) {
  let m;
  if ((m = /^export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)\b/.exec(line))) {
    exportMap.push({ local: m[2], exported: m[2] });
    return line.replace(/^export\s+/, "");
  }
  if ((m = /^export\s+class\s+([A-Za-z_$][\w$]*)\b/.exec(line))) {
    exportMap.push({ local: m[1], exported: m[1] });
    return line.replace(/^export\s+/, "");
  }
  if ((m = /^export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)\b/.exec(line))) {
    exportMap.push({ local: m[2], exported: m[2] });
    return line.replace(/^export\s+/, "");
  }
  if ((m = /^export\s+\{([^}]*)\}\s*;?\s*$/.exec(line))) {
    for (const s of parseSpecs(m[1])) exportMap.push(s);
    return "";
  }
  return line;
}

function transformModule(src, id, idMap) {
  const dir = dirOf(id);
  const exportMap = [];
  const lines = [];
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    let m;
    if ((m = /^import\s+["']([^"']+)["'];?\s*$/.exec(line))) {
      lines.push(`__require(${idMap.get(resolveSpec(dir, m[1]))});`);
    } else if ((m = /^import\s+\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["'];?\s*$/.exec(line))) {
      lines.push(`const ${m[1]} = __require(${idMap.get(resolveSpec(dir, m[2]))});`);
    } else if ((m = /^import\s+\{([^}]*)\}\s+from\s+["']([^"']+)["'];?\s*$/.exec(line))) {
      const names = parseSpecs(m[1]).map(s => (s.local === s.exported ? s.local : `${s.local}: ${s.exported}`)).join(", ");
      lines.push(`const { ${names} } = __require(${idMap.get(resolveSpec(dir, m[2]))});`);
    } else {
      lines.push(transformExport(line, exportMap));
    }
  }
  return { body: lines.join("\n"), exportMap };
}

function bundleModules(read, entry = "core/app") {
  const sources = {};
  const order = [];
  const queue = [entry];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const src = read(id);
    sources[id] = src;
    order.push(id);
    for (const dep of dependencyIds(src, dirOf(id))) if (!seen.has(dep)) queue.push(dep);
  }
  const idMap = new Map(order.map((id, i) => [id, i]));
  const lines = [
    '"use strict";',
    "(() => {",
    "const __mods = [];",
    "const __cache = [];",
    "const __register = (id, fn) => { __mods[id] = fn; };",
    "const __assign = (target, source) => Object.assign(target, source);",
    "const __require = id => { if (__cache[id]) return __cache[id]; const exports = {}; __mods[id](__require, exports); __cache[id] = exports; return exports; };"
  ];
  for (const id of order) {
    const { body, exportMap } = transformModule(sources[id], id, idMap);
    lines.push(`__register(${idMap.get(id)}, (__require, __exports) => {`);
    lines.push(body);
    if (exportMap.length) lines.push(`__assign(__exports, { ${exportMap.map(e => `${e.exported}: ${e.local}`).join(", ")} });`);
    lines.push("});");
  }
  lines.push(`__require(${idMap.get(entry)});`);
  lines.push("})();");
  return lines.join("\n");
}

module.exports = { bundleModules };
