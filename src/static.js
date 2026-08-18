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

const SERVABLE = new Set(Object.keys(MIME));

function headersFor(file, buf) {
  const isHtml = file.endsWith(".html");
  const headers = {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "Content-Length": buf.length,
    "X-Content-Type-Options": "nosniff"
  };
  if (isHtml) {
    headers["Content-Security-Policy"] = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'";
  }
  return Object.freeze(headers);
}

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

  if (cache["/index.html"]) cache["/"] = cache["/index.html"];

  return cache;
}

module.exports = { loadStaticCache };
