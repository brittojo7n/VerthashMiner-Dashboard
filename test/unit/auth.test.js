"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SessionStore, safeEqual, LOCKOUT_THRESHOLD } = require("../../src/auth");
const { createRateLimiter } = require("../../src/ratelimit");

test("safeEqual: constant-time comparison", () => {
  assert.ok(safeEqual("secret", "secret"));
  assert.ok(!safeEqual("secret", "Secret"));
  assert.ok(!safeEqual("secret", ""));
  assert.ok(!safeEqual("", "secret"));
  assert.ok(!safeEqual(null, "x"));
});

test("SessionStore: issue / verify / sliding expiry", () => {
  let now = 100000;
  const s = new SessionStore({ secret: "k", ttlMs: 1000, now: () => now });
  const token = s.issue();
  const cookie = s.cookieFor(token);
  assert.match(cookie, /HttpOnly; Path=\/; Max-Age=1; SameSite=Strict/);
  assert.ok(s.verify(cookie));
  now += 900;
  assert.ok(s.verify(cookie), "verify slides the expiry window");
  now += 1001;
  assert.ok(!s.verify(cookie), "expired token rejected and evicted");
});

test("SessionStore: token extraction is strict", () => {
  assert.equal(SessionStore.tokenFrom("vm_session=abcdef0123456789"), "abcdef0123456789");
  assert.equal(SessionStore.tokenFrom("a=1; vm_session=deadbeefdeadbeef; b=2"), "deadbeefdeadbeef");
  assert.equal(SessionStore.tokenFrom("vm_session=short"), null, "token must be 16+ hex chars");
  assert.equal(SessionStore.tokenFrom(null), null);
});

test("SessionStore: brute-force lockout", () => {
  let now = 1000;
  const s = new SessionStore({ secret: "k", now: () => now });
  const ip = "1.2.3.4";
  for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) {
    s.recordFailure(ip);
    assert.equal(s.lockoutMs(ip), 0);
  }
  s.recordFailure(ip);
  assert.ok(s.lockoutMs(ip) > 0, "locked out at threshold");
  now += 31000;
  assert.equal(s.lockoutMs(ip), 0, "lockout expires");
  s.recordFailure("5.6.7.8");
  s.clearFailures("5.6.7.8");
  assert.equal(s.lockoutMs("5.6.7.8"), 0);
});

test("SessionStore: bounded memory (max sessions, stale sweep)", () => {
  let now = 0;
  const s = new SessionStore({ secret: "k", ttlMs: 50, now: () => now });
  for (let i = 0; i < 60; i++) s.issue();
  assert.ok(s.sessions.size <= 50);
  now = 1000;
  s.prune(true);
  assert.equal(s.sessions.size, 0);
});

test("ratelimit: fixed window with penalty", () => {
  const rl = createRateLimiter(2, 2000, 3000);
  const key = "ip";
  assert.equal(rl(key), 0);
  assert.equal(rl(key), 0);
  const wait = rl(key);
  assert.ok(wait > 0, "third call within window is limited");
  assert.ok(wait <= 3000, "penalty window applied");
  assert.ok(rl("other-ip") === 0, "independent buckets");
});
