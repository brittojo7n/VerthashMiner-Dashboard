const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { formatStatsSnapshot } = require("./state");

const HDR_JSON = Object.freeze({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
const HDR_TEXT = Object.freeze({ "Content-Type": "text/plain", "Cache-Control": "no-store" });
const HDR_SSE  = Object.freeze({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8"
};

function loadStaticCache(publicDir) {
  const dir = publicDir || path.resolve(__dirname, "..", "public");
  const cache = Object.create(null);

  const register = (rel, uri) => {
    try {
      const full = path.join(dir, rel);
      if (!fs.existsSync(full)) return;
      const buf = fs.readFileSync(full);
      cache[uri] = {
        buf,
        hdr: Object.freeze({
          "Content-Type": MIME[path.extname(rel)] || "application/octet-stream",
          "Cache-Control": "public, max-age=0",
          "Content-Length": buf.length
        })
      };
    } catch { }
  };

  register("index.html", "/");
  register("index.html", "/index.html");
  register("style.css",  "/style.css");
  return cache;
}

function getLanIp() {
  let lan = "127.0.0.1";
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) lan = a.address;
    }
  }
  return lan;
}

function parsePathname(rawUrl) {
  const q = rawUrl.indexOf("?");
  return q === -1 ? rawUrl : rawUrl.slice(0, q);
}

function parseToken(rawUrl) {
  const q = rawUrl.indexOf("token=");
  if (q === -1) return null;
  const amp = rawUrl.indexOf("&", q);
  return amp === -1 ? rawUrl.slice(q + 6) : rawUrl.slice(q + 6, amp);
}

function createHttpServer({ config, state, sseHub, publicDir }) {
  const staticFiles = loadStaticCache(publicDir);
  const useToken = config.TOKEN.length > 0;

  const server = http.createServer((req, res) => {
    const raw = req.url || "/";

    if (useToken && parseToken(raw) !== config.TOKEN) {
      res.writeHead(401, HDR_TEXT);
      res.end("Unauthorized");
      return;
    }

    const pathname = parsePathname(raw);

    if (pathname === "/events") {
      res.writeHead(200, HDR_SSE);
      sseHub.handleConnection(req, res);
      return;
    }

    if (pathname === "/health") {
      res.writeHead(200, HDR_TEXT);
      res.end("ok");
      return;
    }

    if (pathname === "/api/status") {
      const body = JSON.stringify(formatStatsSnapshot(state));
      res.writeHead(200, HDR_JSON);
      res.end(body);
      return;
    }

    const sf = staticFiles[pathname];
    if (sf) {
      res.writeHead(200, sf.hdr);
      res.end(sf.buf);
      return;
    }

    res.writeHead(404, HDR_TEXT);
    res.end("Not found");
  });

  return server;
}

module.exports = { getLanIp, createHttpServer };
