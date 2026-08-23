"use strict";

const http = require("node:http");
const os = require("node:os");
const { formatStatsSnapshot } = require("../utils/state");
const { buildAssets, negotiate } = require("./static");
const { SessionStore, safeEqual } = require("./auth");
const { createRateLimiter } = require("./ratelimit");
const { DEBUG } = require("../utils/config");

const NO_STORE = "no-store";
const NOSNIFF = "nosniff";
const HDR_JSON = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": NO_STORE,
  "X-Content-Type-Options": NOSNIFF,
  "Referrer-Policy": "no-referrer"
});
const HDR_TEXT = Object.freeze({
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": NO_STORE,
  "X-Content-Type-Options": NOSNIFF,
  "Referrer-Policy": "no-referrer"
});
const HDR_SSE = Object.freeze({
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
  "X-Content-Type-Options": NOSNIFF,
  "Referrer-Policy": "no-referrer"
});

const MAX_BODY_BYTES = 4096;
const MAX_STREAM_BLOCKS = 128;
const TOO_LARGE = Symbol("payload_too_large");

const SERVER_TIMEOUTS = Object.freeze({
  headersTimeout: 20000,
  requestTimeout: 30000,
  keepAliveTimeout: 5000,
  maxHeadersCount: 64
});

function send(res, status, headers, body) {
  if (res.writableEnded || res.destroyed) return;
  try { res.writeHead(status, headers); res.end(body); } catch (err) { if (DEBUG) console.debug("[dashboard] response write failed:", err.message); }
}
function sendText(res, status, body) { send(res, status, HDR_TEXT, body); }
function sendJson(res, status, payload) { send(res, status, HDR_JSON, JSON.stringify(payload)); }

function sendRateLimited(res, waitMs) {
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  send(res, 429, { ...HDR_JSON, "Retry-After": String(seconds) }, JSON.stringify({
    error: "rate_limited",
    retryAfterMs: waitMs,
    retryAfterSeconds: seconds,
    message: "Too many requests. Please wait before refreshing again."
  }));
}

function getLanIp() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return "127.0.0.1";
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function passesXhrGuard(req) {
  return req.headers["x-requested-with"] === "XMLHttpRequest" && isSameOrigin(req);
}

function readJsonBody(req) {
  return new Promise(resolve => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = value => { if (done) return; done = true; resolve(value); };
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { chunks.length = 0; finish(TOO_LARGE); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { finish(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { finish(null); }
    });
    req.on("error", () => finish(null));
    req.on("aborted", () => finish(null));
  });
}

function createHttpServer({ config, state, sseHub, minerManager, webDir }) {
  const staticFiles = buildAssets(webDir);
  const requiresAuth = config.PASSPHRASE.length > 0;
  const sessions = new SessionStore({ secret: config.SESSION_SECRET });
  const streamBlocks = new Map();

  const limitMiner = createRateLimiter(2, 2000, 3000);
  const limitStatus = createRateLimiter(3, 2000, 3000);
  const limitEvents = createRateLimiter(3, 2000, 3000);
  const limitLogin = createRateLimiter(10, 10000, 10000);

  const routes = new Map();

  routes.set("POST /api/login", async (req, res, ip) => {
    if (!requiresAuth) return sendText(res, 404, "Not found");
    if (!passesXhrGuard(req)) return sendText(res, 403, "Forbidden: CSRF check failed");
    const flood = limitLogin(ip);
    if (flood) return sendRateLimited(res, flood);
    sessions.prune();
    const lockout = sessions.lockoutMs(ip);
    if (lockout) return sendRateLimited(res, lockout);
    const body = await readJsonBody(req);
    if (body === TOO_LARGE) {
      send(res, 413, { ...HDR_TEXT, Connection: "close" }, "Payload Too Large");
      res.on("finish", () => req.destroy());
      return;
    }
    if (!body || typeof body.passphrase !== "string") return sendText(res, 400, "Bad Request");
    if (!safeEqual(body.passphrase, config.PASSPHRASE)) {
      sessions.recordFailure(ip);
      return sendText(res, 401, "Unauthorized");
    }
    sessions.clearFailures(ip);
    const token = sessions.issue();
    send(res, 200, { ...HDR_JSON, "Set-Cookie": sessions.cookieFor(token) }, '{"status":"ok"}');
  });

  routes.set("GET /events", (req, res, ip) => {
    const wait = limitEvents(ip);
    if (wait) {
      if (streamBlocks.size >= MAX_STREAM_BLOCKS) {
        const now = Date.now();
        for (const [key, expiry] of streamBlocks) { if (expiry <= now) streamBlocks.delete(key); }
        if (streamBlocks.size >= MAX_STREAM_BLOCKS) streamBlocks.delete(streamBlocks.keys().next().value);
      }
      streamBlocks.set(ip, Date.now() + wait);
      return sendRateLimited(res, wait);
    }
    streamBlocks.delete(ip);
    if (res.writableEnded || res.destroyed) return;
    req.socket.setTimeout(0);
    res.writeHead(200, HDR_SSE);
    sseHub.handleConnection(req, res);
  });

  routes.set("GET /api/status", (req, res, ip) => {
    const wait = limitStatus(ip);
    if (wait) return sendRateLimited(res, wait);
    const blockedUntil = streamBlocks.get(ip) || 0;
    const streamRetryMs = blockedUntil - Date.now();
    if (streamRetryMs <= 0) {
      if (blockedUntil) streamBlocks.delete(ip);
      return sendJson(res, 200, formatStatsSnapshot(state));
    }
    sendJson(res, 200, {
      ...formatStatsSnapshot(state),
      streamRetryAfterMs: streamRetryMs,
      streamRetryAfterSeconds: Math.max(1, Math.ceil(streamRetryMs / 1000))
    });
  });

  routes.set("GET /health", (req, res) => {
    const snapshot = formatStatsSnapshot(state);
    sendJson(res, 200, {
      status: "ok",
      miner: {
        running: snapshot.miner.running,
        pid: snapshot.miner.pid,
        status: snapshot.mining.status
      },
      gpu: snapshot.gpuError ? { error: snapshot.gpuError } : { count: snapshot.gpu.length },
      sse: { clients: sseHub.size },
      uptime: snapshot.uptimeSeconds
    });
  });

  const minerControl = action => (req, res, ip) => {
    if (!passesXhrGuard(req)) return sendText(res, 403, "Forbidden: CSRF check failed");
    const wait = limitMiner(ip);
    if (wait) return sendRateLimited(res, wait);
    try { minerManager.requestAction(action); } catch { return sendJson(res, 500, { status: "error" }); }
    return sendJson(res, 200, { status: "ok" });
  };
  routes.set("POST /api/miner/start", minerControl("start"));
  routes.set("POST /api/miner/stop", minerControl("stop"));
  routes.set("POST /api/miner/restart", minerControl("restart"));

  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    const queryAt = url.indexOf("?");
    const pathname = queryAt === -1 ? url : url.slice(0, queryAt);
    const method = req.method || "GET";
    const ip = req.socket.remoteAddress || "";

    if (method === "GET" || method === "HEAD") {
      const asset = staticFiles[pathname];
      if (asset) {
        const out = negotiate(asset, req);
        return send(res, out.status, out.headers, out.body);
      }
    }

    const isApi = pathname.startsWith("/api/") || pathname === "/events";
    if (requiresAuth && isApi && pathname !== "/api/login") {
      if (pathname === "/events") sessions.prune();
      if (!sessions.verify(req.headers.cookie)) return sendText(res, 401, "Unauthorized");
    }

    const handler = routes.get(`${method} ${pathname}`);
    if (handler) {
      let result;
      try { result = handler(req, res, ip); } catch { return sendText(res, 500, "Internal Server Error"); }
      if (result && typeof result.catch === "function") result.catch(() => sendText(res, 500, "Internal Server Error"));
      return;
    }
    sendText(res, 404, "Not found");
  });

  Object.assign(server, SERVER_TIMEOUTS);
  server.on("clientError", (err, socket) => {
    if (!socket.writable || socket.destroyed) return;
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  server.sessions = sessions;
  return server;
}

module.exports = { getLanIp, createHttpServer };
