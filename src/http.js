"use strict";

const http = require("node:http");
const os = require("node:os");
const { formatStatsSnapshot } = require("./state");
const { loadStaticCache } = require("./static");
const { SessionStore, safeEqual } = require("./auth");
const { createRateLimiter } = require("./ratelimit");

const NO_STORE = "no-store";
const NOSNIFF = "nosniff";

const HDR_JSON = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": NO_STORE,
  "X-Content-Type-Options": NOSNIFF
});
const HDR_TEXT = Object.freeze({
  "Content-Type": "text/plain",
  "Cache-Control": NO_STORE,
  "X-Content-Type-Options": NOSNIFF
});
const HDR_SSE = Object.freeze({
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
  "X-Content-Type-Options": NOSNIFF
});

const MAX_BODY_BYTES = 4096;
const MAX_STREAM_BLOCKS = 128;
const MINER_ACTIONS = new Set(["start", "stop", "restart"]);

const limitMiner = createRateLimiter(3, 5000);
const limitStatus = createRateLimiter(10, 5000);
const limitEvents = createRateLimiter(4, 5000, 5000);

const send = (res, status, headers, body) => {
  res.writeHead(status, headers);
  res.end(body);
};
const sendText = (res, status, body) => send(res, status, HDR_TEXT, body);
const sendJson = (res, status, payload) => send(res, status, HDR_JSON, JSON.stringify(payload));

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

function readJsonBody(req) {
  return new Promise(resolve => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

function createHttpServer({ config, state, sseHub, minerManager, publicDir }) {
  const staticFiles = loadStaticCache(publicDir);
  const requiresAuth = config.PASSPHRASE.length > 0;
  const sessions = new SessionStore({ secret: config.SESSION_SECRET });
  const streamBlocks = new Map();

  const routes = {
    "POST /api/login": async (req, res, ip) => {
      if (!requiresAuth) return sendText(res, 404, "Not found");
      sessions.prune();

      const lockout = sessions.lockoutMs(ip);
      if (lockout) return sendRateLimited(res, lockout);

      const body = await readJsonBody(req);
      if (!body) return sendText(res, 400, "Bad Request");

      if (!safeEqual(body.passphrase, config.PASSPHRASE)) {
        sessions.recordFailure(ip);
        return sendText(res, 401, "Unauthorized");
      }

      sessions.clearFailures(ip);
      const token = sessions.issue();
      send(res, 200, { ...HDR_JSON, "Set-Cookie": sessions.cookieFor(token) }, '{"status":"ok"}');
    },

    "GET /events": (req, res, ip) => {
      const wait = limitEvents(ip);
      if (wait) {
        if (streamBlocks.size >= MAX_STREAM_BLOCKS) {
          const now = Date.now();
          for (const [key, expiry] of streamBlocks) {
            if (expiry <= now) streamBlocks.delete(key);
          }
          if (streamBlocks.size >= MAX_STREAM_BLOCKS) {
            streamBlocks.delete(streamBlocks.keys().next().value);
          }
        }
        streamBlocks.set(ip, Date.now() + wait);
        return sendRateLimited(res, wait);
      }
      streamBlocks.delete(ip);
      res.writeHead(200, HDR_SSE);
      sseHub.handleConnection(req, res);
    },

    "GET /api/status": (req, res, ip) => {
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
    },

    "GET /health": (req, res) => sendText(res, 200, "ok")
  };

  return http.createServer((req, res) => {
    const url = req.url || "/";
    const queryAt = url.indexOf("?");
    const pathname = queryAt === -1 ? url : url.slice(0, queryAt);
    const method = req.method || "GET";
    const ip = req.socket.remoteAddress || "";

    if (method === "GET") {
      const asset = staticFiles[pathname];
      if (asset) return send(res, 200, asset.hdr, asset.buf);
    }

    const isApi = pathname.startsWith("/api/") || pathname === "/events";
    if (requiresAuth && isApi && pathname !== "/api/login") {
      if (pathname === "/events") sessions.prune();
      if (!sessions.verify(req.headers.cookie)) return sendText(res, 401, "Unauthorized");
    }

    if (method === "POST" && pathname.startsWith("/api/miner/")) {
      const action = pathname.slice("/api/miner/".length);
      if (!MINER_ACTIONS.has(action)) return sendText(res, 404, "Not found");
      const wait = limitMiner(ip);
      if (wait) return sendRateLimited(res, wait);
      minerManager.requestAction(action);
      return sendJson(res, 200, { status: "ok" });
    }

    const handler = routes[`${method} ${pathname}`];
    if (handler) return handler(req, res, ip);

    sendText(res, 404, "Not found");
  });
}

module.exports = { getLanIp, createHttpServer };
