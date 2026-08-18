"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { ROOT } = require("../helpers/harness");
const { loadStaticCache, CSP } = require("../../src/static");

const PUBLIC = path.join(ROOT, "public");
const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
const css = fs.readFileSync(path.join(PUBLIC, "style.css"), "utf8");
const readJs = name => fs.readFileSync(path.join(PUBLIC, "js", name), "utf8");
const jsFiles = fs.readdirSync(path.join(PUBLIC, "js"));

test("the markup honours the Content-Security-Policy", () => {
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), "no inline <script> blocks");
  assert.ok(!/<style[\s>]/i.test(html), "no inline <style> blocks");
  assert.ok(!/\son[a-z]+\s*=/i.test(html), "no inline event handlers");
  assert.ok(!/\sstyle\s*=/i.test(html), "no style attributes");
  assert.match(CSP, /script-src 'self'/);
  assert.match(CSP, /object-src 'none'/);
  assert.match(CSP, /base-uri 'none'/);
});

test("every element id used by the UI exists in the markup", () => {
  const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const used = new Set();
  for (const file of jsFiles) {
    for (const match of readJs(file).matchAll(/\bel\("([^"]+)"\)/g)) used.add(match[1]);
  }

  assert.ok(used.size > 10, "sanity: ids were actually collected");
  for (const id of used) {
    assert.ok(declared.has(id), `app.js references #${id}, which is missing from index.html`);
  }
});

test("no browser module reaches for a hard-coded host", () => {
  for (const file of jsFiles) {
    const source = readJs(file);
    assert.ok(!/https?:\/\/(localhost|127\.0\.0\.1)/.test(source), `${file} hard-codes a host`);
  }
});

test("console output is escaped before it is inserted as HTML", () => {
  const source = readJs("console.js");
  const escapeAt = source.indexOf('replace(/[&<>"\']/g');
  const insertAt = source.indexOf("innerHTML");
  assert.ok(escapeAt !== -1, "an escaping pass must exist");
  assert.ok(escapeAt < insertAt, "escaping must happen before insertion");
  assert.ok(!/innerHTML\s*=\s*[^`'"]*entry\.text/.test(source), "raw log text is never injected");
});

test("layout-stability reservations are present for every element that changes text", () => {
  const rules = [
    ["#status", /#status\s*\{[^}]*min-width/],
    ["#btnAction", /#btnAction[^{]*\{[^}]*min-width/],
    ["#btnAutoScroll", /#btnAutoScroll\s*\{[^}]*min-width/],
    [".console-counter", /\.console-counter\s*\{[^}]*min-width/],
    [".gpu-empty", /\.gpu-empty\s*\{[^}]*min-height/]
  ];
  for (const [name, pattern] of rules) {
    assert.match(css, pattern, `${name} needs a reserved size to avoid layout shift`);
  }
});

test("the error box renders after the console so it cannot displace it", () => {
  const consoleAt = html.indexOf('class="console-box"');
  const errorAt = html.indexOf('id="error"');
  assert.ok(consoleAt !== -1 && errorAt !== -1);
  assert.ok(errorAt > consoleAt, "the error box must come after the console box");
});

test("the static cache serves exactly the public directory, nothing else", () => {
  const cache = loadStaticCache(PUBLIC);
  const urls = Object.keys(cache);

  assert.ok(urls.includes("/"));
  assert.ok(urls.includes("/index.html"));
  assert.ok(urls.includes("/style.css"));
  assert.ok(urls.includes("/js/app.js"));
  assert.ok(urls.includes("/js/present.js"));

  for (const url of urls) {
    assert.ok(url === "/" || /^\/[\w./-]+$/.test(url), `suspicious cache key: ${url}`);
    assert.ok(!url.includes(".."), "no traversal keys");
  }
  assert.ok(!urls.some(u => u.endsWith(".env")), "only whitelisted extensions are cached");
  assert.equal(cache["/index.html"].hdr["X-Content-Type-Options"], "nosniff");
  assert.equal(cache["/style.css"].hdr["Content-Security-Policy"], undefined);
});

test("the browser sources are declared as ES modules for Node too", () => {
  const marker = JSON.parse(fs.readFileSync(path.join(PUBLIC, "package.json"), "utf8"));
  assert.equal(marker.type, "module");
  const cache = loadStaticCache(PUBLIC);
  assert.equal(cache["/package.json"], undefined, "the marker file is never served");
});

test("the browser bundle stays dependency-free and buildless", () => {
  for (const file of jsFiles) {
    const source = readJs(file);
    for (const match of source.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)) {
      assert.ok(
        match[1].startsWith("./") || match[1].startsWith("../"),
        `${file} imports a bare specifier: ${match[1]}`
      );
    }
    assert.ok(!/require\(/.test(source), `${file} must stay an ES module`);
  }
});

test("expensive effects are gated behind the capability class", () => {
  const blurRules = [...css.matchAll(/([^{}]*)\{[^}]*backdrop-filter[^}]*\}/g)]
    .map(m => m[1].trim().split("\n").pop().trim())
    .filter(selector => selector && !selector.startsWith("@"));
  assert.ok(blurRules.length > 0, "the glass effect must still exist");
  for (const selector of blurRules) {
    assert.ok(selector.includes(".fx"), `backdrop-filter must be gated: ${selector}`);
  }

  for (const [name, pattern] of [
    ["pulse", /\.fx \.pulse-indicator\s*\{[^}]*animation/],
    ["cursor", /\.fx \.term-cursor\s*\{[^}]*animation/]
  ]) {
    assert.match(css, pattern, `${name} animation must be gated behind .fx`);
  }

  // The static fallback must still read as glass, not as a flat panel.
  assert.match(css, /\.glass-panel\s*\{[^}]*linear-gradient/);
  assert.match(css, /--shadow-panel:/);
});

test("only the font weights the stylesheet uses are requested", () => {
  const requested = new Set();
  for (const match of html.matchAll(/wght@([\d;]+)/g)) {
    for (const weight of match[1].split(";")) requested.add(weight);
  }
  const used = new Set();
  for (const match of css.matchAll(/font-weight:\s*(\d{3})/g)) used.add(match[1]);
  used.add("400");

  for (const weight of used) {
    assert.ok(requested.has(weight), `weight ${weight} is used but never downloaded`);
  }
  for (const weight of requested) {
    assert.ok(used.has(weight), `weight ${weight} is downloaded but never used`);
  }
});

test("static assets are pre-compressed and revalidatable", () => {
  const cache = loadStaticCache(PUBLIC);
  const css$ = cache["/style.css"];

  assert.ok(css$.gzip, "large text assets must be pre-compressed at boot");
  assert.ok(css$.gzip.length * 2 < css$.buf.length, "gzip must at least halve the payload");
  assert.match(css$.etag, /^"[\w-]{22}"$/);
  assert.equal(css$.gzipHdr["Content-Encoding"], "gzip");
  assert.equal(css$.gzipHdr["Content-Length"], css$.gzip.length);
  assert.equal(css$.hdr.Vary, "Accept-Encoding");
  assert.equal(cache["/"].etag, cache["/index.html"].etag);
});
