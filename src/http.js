const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { formatStatsSnapshot } = require("./state");

const HDR_JSON = Object.freeze({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
const HDR_TEXT = Object.freeze({ "Content-Type": "text/plain", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
const HDR_SSE  = Object.freeze({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });

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
          "Content-Length": buf.length,
          "X-Content-Type-Options": "nosniff"
        })
      };
    } catch { }
  };

  register("index.html", "/");
  register("index.html", "/index.html");
  register("style.css",  "/style.css");
  register("script.js",  "/script.js");
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

function evictSessions(sessions) {
  if (sessions.size < 50) return;
  const now = Date.now();
  for (const [t, exp] of sessions) {
    if (now > exp) sessions.delete(t);
  }
}

function createHttpServer({ config, state, sseHub, minerManager, publicDir }) {
  const staticFiles = loadStaticCache(publicDir);
  const usePassphrase = config.PASSPHRASE.length > 0;
  const sessions = new Map();
  const loginAttempts = new Map();

  const server = http.createServer(async (req, res) => {
    const raw = req.url || "/";
    const pathname = parsePathname(raw);

    if (usePassphrase && req.method === "POST" && pathname === "/api/login") {
      evictSessions(sessions);
      const ip = req.socket.remoteAddress;
      const now = Date.now();

      for (const [key, val] of loginAttempts) {
        val.failures = val.failures.filter(t => now - t < 60000);
        if (val.failures.length === 0 && val.blockedUntil <= now) {
          loginAttempts.delete(key);
        }
      }

      let attempt = loginAttempts.get(ip);
      if (!attempt) {
        if (loginAttempts.size >= 100) {
          const firstKey = loginAttempts.keys().next().value;
          if (firstKey) loginAttempts.delete(firstKey);
        }
        attempt = { failures: [], blockedUntil: 0 };
        loginAttempts.set(ip, attempt);
      }

      if (attempt.blockedUntil > now) {
        res.writeHead(429, HDR_TEXT);
        res.end("Too Many Requests");
        return;
      }

      let body = "";
      let bodyLen = 0;
      req.on("data", c => {
        bodyLen += c.length;
        if (bodyLen > 4096) {
          req.destroy();
          return;
        }
        body += c;
      });
      req.on("end", () => {
        if (bodyLen > 4096) return;
        try {
          const payload = JSON.parse(body);
          if (payload.passphrase === config.PASSPHRASE) {
            attempt.failures = [];
            attempt.blockedUntil = 0;

            const token = crypto.createHmac("sha256", config.SESSION_SECRET).update(crypto.randomBytes(32)).digest("hex");
            sessions.set(token, Date.now() + 1800 * 1000);
            res.writeHead(200, {
              ...HDR_JSON,
              "Set-Cookie": `vm_session=${token}; HttpOnly; Path=/; Max-Age=1800; SameSite=Strict`
            });
            res.end('{"status":"ok"}');
          } else {
            attempt.failures.push(now);
            if (attempt.failures.length >= 5) {
              attempt.blockedUntil = now + 30000;
            }
            res.writeHead(401, HDR_TEXT);
            res.end("Unauthorized");
          }
        } catch {
          res.writeHead(400, HDR_TEXT);
          res.end("Bad Request");
        }
      });
      return;
    }

    const isApi = pathname.startsWith("/api/") || pathname === "/events";
    if (usePassphrase && isApi && pathname !== "/api/login") {
      if (pathname === "/events") evictSessions(sessions);
      let token = null;
      if (req.headers.cookie) {
        const match = req.headers.cookie.match(/vm_session=([0-9a-f]+)/);
        if (match) token = match[1];
      }
      const expiresAt = sessions.get(token);
      if (!expiresAt || Date.now() > expiresAt) {
        if (token) sessions.delete(token);
        res.writeHead(401, HDR_TEXT);
        res.end("Unauthorized");
        return;
      }
    }

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

    if (req.method === "POST" && pathname.startsWith("/api/miner/")) {
      const action = pathname.slice(12);
      if (action === "start" || action === "stop" || action === "restart") {
        minerManager.requestAction(action);
        res.writeHead(200, HDR_JSON);
        res.end('{"status":"ok"}');
        return;
      }
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
