"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const SERVABLE = new Set(Object.keys(MIME));
const MIN_COMPRESS_BYTES = 512;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");

const PERMISSIONS = "camera=(), microphone=(), geolocation=(), interest-cohort=()";

function etagOf(buf) {
  return `"${crypto.createHash("sha1").update(buf).digest("base64url").slice(0, 22)}"`;
}

function headersFor(file, length, etag, encoding) {
  const headers = {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "Content-Length": length,
    ETag: etag,
    Vary: "Accept-Encoding",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  };
  if (encoding) headers["Content-Encoding"] = encoding;
  if (file.endsWith(".html")) { headers["Content-Security-Policy"] = CSP; headers["Permissions-Policy"] = PERMISSIONS; }
  return Object.freeze(headers);
}

function notModifiedHeaders(etag) {
  return Object.freeze({ ETag: etag, "Cache-Control": "no-cache", Vary: "Accept-Encoding" });
}

function loadStaticCache(publicDir) {
  const root = publicDir || path.resolve(__dirname, "..", "public");
  const cache = Object.create(null);

  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (!SERVABLE.has(ext)) continue;
      let buf;
      try { buf = fs.readFileSync(full); } catch { continue; }
      const etag = etagOf(buf);
      const asset = {
        buf,
        etag,
        hdr: headersFor(entry.name, buf.length, etag),
        notModified: notModifiedHeaders(etag),
        gzip: null,
        gzipHdr: null
      };
      cache["/" + path.relative(root, full).split(path.sep).join("/")] = asset;
    }
  };

  walk(root);
  if (cache["/index.html"]) cache["/"] = cache["/index.html"];
  return cache;
}

module.exports = { loadStaticCache, CSP, MIME };
