const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { formatStatsSnapshot } = require("./state");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function loadStaticCache(publicDir = path.resolve(__dirname, "..", "public")) {
  const staticCache = {};

  const registerFile = (relPath, uri) => {
    try {
      const fullPath = path.join(publicDir, relPath);
      if (fs.existsSync(fullPath)) {
        const buf = fs.readFileSync(fullPath);
        const ext = path.extname(relPath);
        staticCache[uri] = {
          buf,
          type: MIME_TYPES[ext] || "application/octet-stream"
        };
      }
    } catch { }
  };

  registerFile("index.html", "/");
  registerFile("index.html", "/index.html");
  registerFile("style.css", "/style.css");

  return staticCache;
}

function send(res, status, type, body, len) {
  const headers = {
    "Content-Type": type,
    "Cache-Control": "no-store"
  };
  if (len !== undefined) {
    headers["Content-Length"] = len;
  }
  res.writeHead(status, headers);
  res.end(body);
}

function getLanIp() {
  let lan = "127.0.0.1";
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const e of entries || []) {
      if (e.family === "IPv4" && !e.internal) {
        lan = e.address;
      }
    }
  }
  return lan;
}

function createHttpServer({ config, state, sseHub, publicDir }) {
  const staticFiles = loadStaticCache(publicDir);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (config.TOKEN && url.searchParams.get("token") !== config.TOKEN) {
      return send(res, 401, "text/plain", "Unauthorized");
    }

    const pathname = url.pathname;

    if (pathname === "/api/status") {
      const payload = JSON.stringify(formatStatsSnapshot(state));
      return send(res, 200, "application/json; charset=utf-8", payload);
    }

    if (pathname === "/events") {
      return sseHub.handleConnection(req, res);
    }

    if (pathname === "/health") {
      return send(res, 200, "text/plain", "ok");
    }

    const staticFile = staticFiles[pathname];
    if (staticFile) {
      return send(res, 200, staticFile.type, staticFile.buf, staticFile.buf.length);
    }

    send(res, 404, "text/plain", "Not found");
  });

  return server;
}

module.exports = {
  MIME_TYPES,
  loadStaticCache,
  send,
  getLanIp,
  createHttpServer
};
