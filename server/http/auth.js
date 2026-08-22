"use strict";

const crypto = require("node:crypto");
const { LIMITS } = require("../core/constants");

const MAX_SESSIONS = 50;
const MAX_TRACKED_IPS = 100;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 30000;
const FAILURE_WINDOW_MS = 60000;
const SWEEP_INTERVAL_MS = 10000;
const TOKEN_RE = /(?:^|;\s*)vm_session=([0-9a-f]{16,128})(?:\s*;|\s*$)/;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

class SessionStore {
  constructor({ secret, ttlMs = LIMITS.SESSION_TTL_MS, now = Date.now } = {}) {
    this.secret = secret;
    this.ttlMs = ttlMs;
    this.now = now;
    this.sessions = new Map();
    this.attempts = new Map();
    this.lastSweep = 0;
  }

  prune(force = false) {
    const now = this.now();
    if (!force && this.sessions.size < MAX_SESSIONS && now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [token, expiry] of this.sessions) { if (now > expiry) this.sessions.delete(token); }
  }

  issue() {
    const token = crypto.createHmac("sha256", this.secret).update(crypto.randomBytes(32)).digest("hex");
    this.prune(true);
    while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value);
    this.sessions.set(token, this.now() + this.ttlMs);
    return token;
  }

  cookieFor(token, secure = false) {
    return `vm_session=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(this.ttlMs / 1000)}; SameSite=Strict${secure ? "; Secure" : ""}`;
  }

  static tokenFrom(cookieHeader) {
    if (!cookieHeader) return null;
    const match = TOKEN_RE.exec(cookieHeader);
    return match ? match[1] : null;
  }

  verify(cookieHeader) {
    const token = SessionStore.tokenFrom(cookieHeader);
    if (!token) return false;
    const expiry = this.sessions.get(token);
    const now = this.now();
    if (!expiry || now > expiry) { this.sessions.delete(token); return false; }
    this.sessions.set(token, now + this.ttlMs);
    return true;
  }

  revoke(cookieHeader) {
    const token = SessionStore.tokenFrom(cookieHeader);
    if (token) this.sessions.delete(token);
  }

  _sweepAttempts(now) {
    for (const [key, entry] of this.attempts) {
      if (entry.blockedUntil > now) continue;
      let live = 0;
      for (const t of entry.failures) if (now - t < FAILURE_WINDOW_MS) live++;
      if (live === 0) this.attempts.delete(key);
      else if (live !== entry.failures.length) entry.failures = entry.failures.filter(t => now - t < FAILURE_WINDOW_MS);
    }
  }

  lockoutMs(ip) {
    const now = this.now();
    if (now - this.lastSweep >= SWEEP_INTERVAL_MS || this.attempts.size >= MAX_TRACKED_IPS) {
      this.lastSweep = now;
      this._sweepAttempts(now);
    }
    const entry = this.attempts.get(ip);
    return entry && entry.blockedUntil > now ? entry.blockedUntil - now : 0;
  }

  recordFailure(ip) {
    const now = this.now();
    let entry = this.attempts.get(ip);
    if (!entry) {
      if (this.attempts.size >= MAX_TRACKED_IPS) {
        this._sweepAttempts(now);
        while (this.attempts.size >= MAX_TRACKED_IPS) this.attempts.delete(this.attempts.keys().next().value);
      }
      entry = { failures: [], blockedUntil: 0 };
      this.attempts.set(ip, entry);
    }
    entry.failures.push(now);
    if (entry.failures.length > LOCKOUT_THRESHOLD * 2) entry.failures = entry.failures.slice(-LOCKOUT_THRESHOLD);
    const recent = entry.failures.filter(t => now - t < FAILURE_WINDOW_MS);
    if (recent.length >= LOCKOUT_THRESHOLD) entry.blockedUntil = now + LOCKOUT_MS;
  }

  clearFailures(ip) { this.attempts.delete(ip); }
}

module.exports = { SessionStore, safeEqual };
