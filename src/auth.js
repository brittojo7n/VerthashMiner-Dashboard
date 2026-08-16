"use strict";

const crypto = require("node:crypto");
const { LIMITS } = require("./constants");

const MAX_SESSIONS = 50;
const MAX_TRACKED_IPS = 100;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 30000;
const FAILURE_WINDOW_MS = 60000;
const TOKEN_RE = /vm_session=([0-9a-f]+)/;

/**
 * Constant-time string comparison. Hashing first equalises buffer lengths, so
 * neither the passphrase contents nor its length leak through timing.
 */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Cookie-based session store with brute-force lockout.
 *
 * Both maps are explicitly bounded so a hostile client cannot grow them without
 * limit; expired entries are swept lazily rather than on a timer, keeping the
 * process idle when nobody is connected.
 */
class SessionStore {
  constructor({ secret, ttlMs = LIMITS.SESSION_TTL_MS } = {}) {
    this.secret = secret;
    this.ttlMs = ttlMs;
    this.sessions = new Map();
    this.attempts = new Map();
  }

  /** Drop expired sessions once the map is large enough to be worth sweeping. */
  prune() {
    if (this.sessions.size < MAX_SESSIONS) return;
    const now = Date.now();
    for (const [token, expiry] of this.sessions) {
      if (now > expiry) this.sessions.delete(token);
    }
  }

  issue() {
    const token = crypto
      .createHmac("sha256", this.secret)
      .update(crypto.randomBytes(32))
      .digest("hex");
    this.sessions.set(token, Date.now() + this.ttlMs);
    return token;
  }

  cookieFor(token) {
    return `vm_session=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(this.ttlMs / 1000)}; SameSite=Strict`;
  }

  static tokenFrom(cookieHeader) {
    if (!cookieHeader) return null;
    const match = TOKEN_RE.exec(cookieHeader);
    return match ? match[1] : null;
  }

  /**
   * Validate a request cookie and, on success, slide the expiry forward so an
   * operator watching the rig is never logged out mid-session.
   */
  verify(cookieHeader) {
    const token = SessionStore.tokenFrom(cookieHeader);
    if (!token) return false;
    const expiry = this.sessions.get(token);
    if (!expiry || Date.now() > expiry) {
      if (token) this.sessions.delete(token);
      return false;
    }
    this.sessions.set(token, Date.now() + this.ttlMs);
    return true;
  }

  /** Milliseconds remaining on a lockout, or 0 when the caller may try. */
  lockoutMs(ip) {
    const now = Date.now();

    for (const [key, entry] of this.attempts) {
      entry.failures = entry.failures.filter(t => now - t < FAILURE_WINDOW_MS);
      if (!entry.failures.length && entry.blockedUntil <= now) this.attempts.delete(key);
    }

    const entry = this.attempts.get(ip);
    return entry && entry.blockedUntil > now ? entry.blockedUntil - now : 0;
  }

  recordFailure(ip) {
    let entry = this.attempts.get(ip);
    if (!entry) {
      if (this.attempts.size >= MAX_TRACKED_IPS) {
        this.attempts.delete(this.attempts.keys().next().value);
      }
      entry = { failures: [], blockedUntil: 0 };
      this.attempts.set(ip, entry);
    }
    entry.failures.push(Date.now());
    if (entry.failures.length >= LOCKOUT_THRESHOLD) {
      entry.blockedUntil = Date.now() + LOCKOUT_MS;
    }
  }

  clearFailures(ip) {
    this.attempts.delete(ip);
  }
}

module.exports = { SessionStore, safeEqual };
