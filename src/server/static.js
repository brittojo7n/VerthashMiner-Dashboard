"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { bundleModules } = require("./bundle");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const COMPRESSIBLE = new Set([".html", ".css", ".js", ".svg"]);
const MIN_COMPRESS_BYTES = 512;
const PERMISSIONS = "camera=(), microphone=(), geolocation=(), interest-cohort=()";

function buildCsp(scriptHash) {
  return [
    "default-src 'self'",
    `script-src 'self' 'sha256-${scriptHash}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join("; ");
}

function etagOf(buf) {
  return `"${crypto.createHash("sha1").update(buf).digest("base64url").slice(0, 22)}"`;
}

function headersFor(name, length, etag, encoding, csp) {
  const headers = {
    "Content-Type": MIME[path.extname(name)] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "Content-Length": length,
    ETag: etag,
    Vary: "Accept-Encoding",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  };
  if (encoding) headers["Content-Encoding"] = encoding;
  if (name.endsWith(".html")) {
    headers["Content-Security-Policy"] = csp;
    headers["Permissions-Policy"] = PERMISSIONS;
  }
  return Object.freeze(headers);
}

function notModifiedHeaders(etag) {
  return Object.freeze({ ETag: etag, "Cache-Control": "no-cache", Vary: "Accept-Encoding" });
}

function makeAsset(name, buf, csp) {
  const etag = etagOf(buf);
  const asset = {
    buf,
    etag,
    hdr: headersFor(name, buf.length, etag, undefined, csp),
    notModified: notModifiedHeaders(etag),
    compressible: COMPRESSIBLE.has(path.extname(name)),
    gzip: null,
    gzipHdr: null
  };
  if (asset.compressible && buf.length >= MIN_COMPRESS_BYTES) {
    try {
      const gzip = zlib.gzipSync(buf, { level: zlib.constants.Z_BEST_COMPRESSION });
      if (gzip.length < buf.length) {
        asset.gzip = gzip;
        asset.gzipHdr = headersFor(name, gzip.length, etag, "gzip", csp);
      } else {
        asset.gzip = false;
      }
    } catch {
      asset.gzip = false;
    }
  }
  return asset;
}

function buildAssets(clientDir) {
  const root = clientDir || path.resolve(__dirname, "..", "..", "client");
  const readScript = name => fs.readFileSync(path.join(root, "scripts", `${name}.js`), "utf8");
  const head = readScript("head").trim();
  const scriptHash = crypto.createHash("sha256").update(head).digest("base64");
  const csp = buildCsp(scriptHash);

  const modules = {};
  const app = bundleModules(id => (modules[id] = readScript(id)));

  let html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  html = html.replace('<script src="/js/head.js"></script>', `<script>${head}</script>`);
  html = html.replace('<script type="module" src="/js/app.js"></script>', '<script src="/app.js"></script>');

  const css = fs.readFileSync(path.join(root, "styles", "style.css"), "utf8");
  const favicon = fs.readFileSync(path.join(root, "assets", "favicon.svg"));

  const assets = Object.create(null);
  const index = makeAsset("index.html", Buffer.from(html), csp);
  assets["/"] = index;
  assets["/index.html"] = index;
  assets["/app.js"] = makeAsset("app.js", Buffer.from(app), csp);
  assets["/style.css"] = makeAsset("style.css", Buffer.from(css), csp);
  assets["/favicon.svg"] = makeAsset("favicon.svg", favicon, csp);
  return assets;
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

module.exports = { buildAssets, negotiate, MIME };
