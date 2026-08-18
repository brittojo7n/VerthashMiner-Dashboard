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

/**
 * Content Security Policy.
 *
 * - `script-src 'self'` — no inline scripts anywhere in the UI.
 * - `style-src` keeps `'unsafe-inline'` only because the Google Fonts
 *   stylesheet is loaded cross-origin; the app itself ships no inline <style>.
 * - `object-src`/`base-uri`/`form-action 'none'` remove the classic
 *   injection escape hatches.
 *
 * `frame-ancestors` is deliberately omitted: the session cookie is
 * `SameSite=Strict`, so a framed copy of the dashboard is always logged out
 * and cannot be used for clickjacking, while omitting the directive keeps the
 * page embeddable in local monitoring walls.
 */
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

function headersFor(file, buf) {
  const headers = {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "Content-Length": buf.length,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  };
  if (file.endsWith(".html")) {
    headers["Content-Security-Policy"] = CSP;
    headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), interest-cohort=()";
  }
  return Object.freeze(headers);
}

/**
 * Reads the whole public directory into memory once at boot.
 * The resulting map is the *only* thing the HTTP layer will ever serve from
 * disk, which makes path traversal structurally impossible: no request path is
 * ever concatenated with a filesystem path.
 *
 * @param {string} [publicDir]
 * @returns {Record<string, {buf: Buffer, hdr: object}>}
 */
function loadStaticCache(publicDir) {
  const root = publicDir || path.resolve(__dirname, "..", "public");
  const cache = Object.create(null);

  const walk = dir => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // Regular files only: a symlink must never be able to publish something
      // from outside the public directory.
      if (!entry.isFile()) continue;
      if (!SERVABLE.has(path.extname(entry.name))) continue;

      let buf;
      try {
        buf = fs.readFileSync(full);
      } catch {
        continue;
      }

      const url = "/" + path.relative(root, full).split(path.sep).join("/");
      cache[url] = { buf, hdr: headersFor(entry.name, buf) };
    }
  };

  walk(root);

  if (cache["/index.html"]) cache["/"] = cache["/index.html"];

  return cache;
}

module.exports = { loadStaticCache, CSP, MIME };
