"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

/** Only these extensions are published, so nothing unexpected can leak out. */
const SERVABLE = new Set(Object.keys(MIME));

function headersFor(file, buf) {
  return Object.freeze({
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    // `no-cache` revalidates rather than storing: keeps a passphrase-protected
    // UI out of shared caches while still allowing conditional requests.
    "Cache-Control": "no-cache",
    "Content-Length": buf.length,
    "X-Content-Type-Options": "nosniff"
  });
}

/**
 * Read every public asset once at boot so request handling never touches disk.
 * Bodies and headers are precomputed and shared between aliases.
 *
 * @param {string} [publicDir]
 * @returns {Record<string, {buf: Buffer, hdr: object}>}
 */
function loadStaticCache(publicDir) {
  const root = publicDir || path.resolve(__dirname, "..", "public");
  const cache = Object.create(null);

  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!SERVABLE.has(path.extname(entry.name))) continue;

      let buf;
      try { buf = fs.readFileSync(full); } catch { continue; }

      const url = "/" + path.relative(root, full).split(path.sep).join("/");
      cache[url] = { buf, hdr: headersFor(entry.name, buf) };
    }
  };

  walk(root);

  // Serve the shell at the site root as well.
  if (cache["/index.html"]) cache["/"] = cache["/index.html"];

  return cache;
}

module.exports = { loadStaticCache };
