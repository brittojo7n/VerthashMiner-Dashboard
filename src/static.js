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
const COMPRESSIBLE = new Set([".html", ".css", ".js", ".svg"]);
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
        compressible: COMPRESSIBLE.has(ext),
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

function negotiate(asset, req) {
  if (req.headers["if-none-match"] === asset.etag) return { status: 304, headers: asset.notModified };
  let headers = asset.hdr;
  let body = asset.buf;
  const encodings = req.headers["accept-encoding"];
  if (asset.compressible && asset.buf.length >= MIN_COMPRESS_BYTES && typeof encodings === "string" && encodings.includes("gzip")) {
    if (asset.gzip === null) {
      try {
        const gz = zlib.gzipSync(asset.buf, { level: zlib.constants.Z_BEST_COMPRESSION });
        if (gz.length < asset.buf.length) {
          asset.gzip = gz;
          asset.gzipHdr = Object.freeze({ ...asset.hdr, "Content-Encoding": "gzip", "Content-Length": gz.length });
        } else {
          asset.gzip = false;
        }
      } catch {
        asset.gzip = false;
      }
    }
    if (asset.gzip) {
      headers = asset.gzipHdr;
      body = asset.gzip;
    }
  }
  if (req.method === "HEAD") return { status: 200, headers, body: undefined };
  return { status: 200, headers, body };
}

module.exports = { loadStaticCache, negotiate, CSP, MIME };
