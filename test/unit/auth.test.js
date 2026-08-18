"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { SessionStore, safeEqual, MAX_SESSIONS, LOCKOUT_THRESHOLD } = require("../../src/auth");

const SECRET = "unit-test-secret".padEnd(64, "0");

function storeWithClock() {
  let now = 1_000_000;
  const store = new SessionStore({ secret: SECRET, ttlMs: 1000, now: () => now });
  return { store, advance: ms => (now += ms), at: () => now };
}

test("safeEqual compares correctly and rejects non-strings", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false, "different lengths must not throw");
  assert.equal(safeEqual("", ""), true);
  assert.equal(safeEqual(undefined, "x"), false);
  assert.equal(safeEqual(null, null), false);
  assert.equal(safeEqual({ toString: () => "x" }, "x"), false);
  assert.equal(safeEqual("ünïcødé", "ünïcødé"), true);
});

test("issued tokens are unpredictable and unique", () => {
  const store = new SessionStore({ secret: SECRET });
  const tokens = new Set();
  for (let i = 0; i < 200; i++) tokens.add(store.issue());
  assert.equal(tokens.size, 200);
  for (const token of tokens) assert.match(token, /^[0-9a-f]{64}$/);
});

test("a valid cookie authenticates and slides its expiry", () => {
  const { store, advance } = storeWithClock();
  const token = store.issue();
  const cookie = `vm_session=${token}`;

  assert.equal(store.verify(cookie), true);
  advance(800);
  assert.equal(store.verify(cookie), true, "sliding window keeps it alive");
  advance(1500);
  assert.equal(store.verify(cookie), false, "expired");
  assert.equal(store.sessions.has(token), false, "expired token is evicted");
});

test("forged and malformed cookies are rejected", () => {
  const store = new SessionStore({ secret: SECRET });
  const token = store.issue();

  for (const cookie of [
    undefined,
    "",
    "vm_session=",
    "vm_session=zzzz",
    `vm_session=${"a".repeat(64)}`,
    `other=vm_session=${token}`,
    `x=1; vm_session=${token.slice(0, 32)}`,
    `vm_session=${token}extra`
  ]) {
    assert.equal(store.verify(cookie), false, `must reject: ${cookie}`);
  }

  assert.equal(store.verify(`a=1; vm_session=${token}; b=2`), true, "real cookie among others");
});

test("session count is capped even with a valid passphrase", () => {
  const store = new SessionStore({ secret: SECRET });
  for (let i = 0; i < MAX_SESSIONS * 3; i++) store.issue();
  assert.ok(store.sessions.size <= MAX_SESSIONS, `size=${store.sessions.size}`);
});

test("brute force locks out after the threshold and recovers", () => {
  const { store, advance } = storeWithClock();
  const ip = "10.0.0.5";

  for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) {
    store.recordFailure(ip);
    assert.equal(store.lockoutMs(ip), 0, `attempt ${i + 1} still allowed`);
  }
  store.recordFailure(ip);
  assert.ok(store.lockoutMs(ip) > 0, "locked out");

  advance(31_000);
  assert.equal(store.lockoutMs(ip), 0, "lockout expires");
});

test("a successful login clears the failure history", () => {
  const store = new SessionStore({ secret: SECRET });
  for (let i = 0; i < LOCKOUT_THRESHOLD; i++) store.recordFailure("1.2.3.4");
  assert.ok(store.lockoutMs("1.2.3.4") > 0);
  store.clearFailures("1.2.3.4");
  assert.equal(store.lockoutMs("1.2.3.4"), 0);
});

test("failure tracking is bounded under an address-cycling flood", () => {
  const store = new SessionStore({ secret: SECRET });
  for (let i = 0; i < 5000; i++) store.recordFailure(`10.1.${i % 251}.${i % 253}`);
  assert.ok(store.attempts.size <= 100, `tracked=${store.attempts.size}`);
  for (const entry of store.attempts.values()) {
    assert.ok(entry.failures.length <= LOCKOUT_THRESHOLD * 2);
  }
});

test("lockout is per address, not global", () => {
  const store = new SessionStore({ secret: SECRET });
  for (let i = 0; i < LOCKOUT_THRESHOLD; i++) store.recordFailure("1.1.1.1");
  assert.ok(store.lockoutMs("1.1.1.1") > 0);
  assert.equal(store.lockoutMs("2.2.2.2"), 0);
});

test("cookie attributes stay restrictive", () => {
  const store = new SessionStore({ secret: SECRET, ttlMs: 60_000 });
  const cookie = store.cookieFor(store.issue());
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=60/);
  assert.ok(!cookie.includes("Secure"), "plain HTTP deployments must still work");
  assert.match(store.cookieFor("abc", true), /Secure/);
});

test("pruning removes expired sessions without touching live ones", () => {
  const { store, advance } = storeWithClock();
  const stale = store.issue();
  advance(1200);
  const fresh = store.issue();
  store.prune(true);
  assert.equal(store.sessions.has(stale), false);
  assert.equal(store.sessions.has(fresh), true);
});

test("comparison time does not leak the passphrase prefix", () => {
  // Statistical smoke test: a near-match must not be measurably slower than a
  // total mismatch. Uses medians over many samples to damp scheduler noise.
  const secret = crypto.randomBytes(24).toString("hex");
  const near = `${secret.slice(0, -1)}x`;
  const far = "z".repeat(secret.length);

  const measure = candidate => {
    const samples = [];
    for (let i = 0; i < 400; i++) {
      const t0 = process.hrtime.bigint();
      safeEqual(candidate, secret);
      samples.push(Number(process.hrtime.bigint() - t0));
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
  };

  const nearMedian = measure(near);
  const farMedian = measure(far);
  const ratio = nearMedian / farMedian;
  assert.ok(ratio > 0.25 && ratio < 4, `timing ratio out of band: ${ratio.toFixed(2)}`);
});
