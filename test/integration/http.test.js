"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { startServer, request, sseClient, delay } = require("../helpers/harness");
const { LIMITS } = require("../../src/constants");

const XHR = { "X-Requested-With": "XMLHttpRequest" };

test("open dashboard: static assets, status and stream are reachable", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const index = await request(app.origin, "/");
  assert.equal(index.status, 200);
  assert.match(index.headers["content-type"], /text\/html/);
  assert.match(index.headers["content-security-policy"], /default-src 'self'/);
  assert.match(index.headers["content-security-policy"], /object-src 'none'/);
  assert.equal(index.headers["x-content-type-options"], "nosniff");

  const css = await request(app.origin, "/style.css");
  assert.equal(css.status, 200);
  assert.match(css.headers["content-type"], /text\/css/);

  const head = await request(app.origin, "/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");

  const health = await request(app.origin, "/health");
  assert.equal(health.body, "ok");

  const status = await request(app.origin, "/api/status");
  assert.equal(status.status, 200);
  const snapshot = status.json();
  assert.ok(snapshot.mining);
  assert.ok(Array.isArray(snapshot.gpu));
  assert.equal(status.headers["cache-control"], "no-store");
});

test("unknown paths and traversal attempts return 404 without touching disk", async t => {
  const app = await startServer();
  t.after(() => app.close());

  for (const path of [
    "/../server.js",
    "/..%2fserver.js",
    "/js/../../.env",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/.env",
    "/nope",
    "/js/",
    "//etc/passwd",
    "/js/app.js%00.png"
  ]) {
    const res = await request(app.origin, path);
    assert.equal(res.status, 404, `${path} -> ${res.status}`);
    assert.ok(!res.body.includes("SESSION_SECRET"), "no file contents leaked");
  }
});

test("protected deployment: everything but the login page requires a session", async t => {
  const app = await startServer({ env: { PASSPHRASE: "correct horse" } });
  t.after(() => app.close());

  assert.equal((await request(app.origin, "/")).status, 200, "login UI stays reachable");
  assert.equal((await request(app.origin, "/api/status")).status, 401);
  assert.equal(
    (await request(app.origin, "/api/miner/start", { method: "POST", headers: XHR })).status,
    401
  );

  const stream = await request(app.origin, "/events");
  assert.equal(stream.status, 401);
});

test("login issues a hardened cookie and unlocks the API", async t => {
  const app = await startServer({ env: { PASSPHRASE: "correct horse" } });
  t.after(() => app.close());

  const bad = await request(app.origin, "/api/login", {
    method: "POST",
    headers: XHR,
    body: { passphrase: "wrong" }
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers["set-cookie"], undefined);

  const good = await request(app.origin, "/api/login", {
    method: "POST",
    headers: XHR,
    body: { passphrase: "correct horse" }
  });
  assert.equal(good.status, 200);
  const cookie = good.headers["set-cookie"][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const authed = await request(app.origin, "/api/status", {
    headers: { Cookie: cookie.split(";")[0] }
  });
  assert.equal(authed.status, 200);
});

test("CSRF: state-changing calls need the XHR header and a same-origin Origin", async t => {
  const app = await startServer({ env: { PASSPHRASE: "pw" } });
  t.after(() => app.close());

  const noHeader = await request(app.origin, "/api/login", {
    method: "POST",
    body: { passphrase: "pw" }
  });
  assert.equal(noHeader.status, 403);

  const foreignOrigin = await request(app.origin, "/api/login", {
    method: "POST",
    headers: { ...XHR, Origin: "http://evil.example" },
    body: { passphrase: "pw" }
  });
  assert.equal(foreignOrigin.status, 403);

  const login = await request(app.origin, "/api/login", {
    method: "POST",
    headers: { ...XHR, Origin: app.origin },
    body: { passphrase: "pw" }
  });
  assert.equal(login.status, 200);

  const cookie = login.headers["set-cookie"][0].split(";")[0];
  const forgedAction = await request(app.origin, "/api/miner/stop", {
    method: "POST",
    headers: { Cookie: cookie, Origin: "http://evil.example", ...XHR }
  });
  assert.equal(forgedAction.status, 403);
});

test("brute force is locked out after repeated failures", async t => {
  const app = await startServer({ env: { PASSPHRASE: "pw" } });
  t.after(() => app.close());

  let sawLockout = false;
  for (let i = 0; i < 8; i++) {
    const res = await request(app.origin, "/api/login", {
      method: "POST",
      headers: XHR,
      body: { passphrase: `guess-${i}` }
    });
    if (res.status === 429) {
      sawLockout = true;
      assert.ok(Number(res.headers["retry-after"]) > 0);
      break;
    }
  }
  assert.ok(sawLockout, "repeated failures must trigger a lockout");

  // The correct passphrase is refused while locked out.
  const blocked = await request(app.origin, "/api/login", {
    method: "POST",
    headers: XHR,
    body: { passphrase: "pw" }
  });
  assert.equal(blocked.status, 429);
});

test("malformed and oversized login bodies are rejected safely", async t => {
  const app = await startServer({ env: { PASSPHRASE: "pw" } });
  t.after(() => app.close());

  const cases = [
    "",
    "not json",
    "[]",
    '{"passphrase":null}',
    '{"passphrase":{"toString":"x"}}',
    JSON.stringify({ passphrase: "x".repeat(64 * 1024) })
  ];

  for (const body of cases) {
    const res = await request(app.origin, "/api/login", { method: "POST", headers: XHR, body });
    assert.ok(
      [400, 401, 413, 429].includes(res.status),
      `body ${body.slice(0, 20)} -> ${res.status}`
    );
  }

  assert.equal((await request(app.origin, "/health")).status, 200, "server survived");
});

test("miner control endpoints validate the action name", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const ok = await request(app.origin, "/api/miner/stop", { method: "POST", headers: XHR });
  assert.equal(ok.status, 200);

  for (const action of ["../../etc/passwd", "dispose", "constructor", "__proto__", "restart%00"]) {
    const res = await request(app.origin, `/api/miner/${action}`, { method: "POST", headers: XHR });
    assert.equal(res.status, 404, action);
  }
});

test("route lookup cannot reach Object.prototype members", async t => {
  const app = await startServer();
  t.after(() => app.close());

  for (const path of ["/constructor", "/toString", "/__proto__", "/hasOwnProperty"]) {
    const res = await request(app.origin, path);
    assert.equal(res.status, 404, path);
  }
});

test("status polling is rate limited with Retry-After guidance", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const results = [];
  for (let i = 0; i < 8; i++) results.push(await request(app.origin, "/api/status"));

  const limited = results.filter(r => r.status === 429);
  assert.ok(limited.length > 0, "limiter must engage");
  const payload = limited[0].json();
  assert.equal(payload.error, "rate_limited");
  assert.ok(payload.retryAfterMs > 0);
  assert.ok(Number(limited[0].headers["retry-after"]) >= 1);
});

test("SSE delivers an immediate snapshot then live deltas", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const client = sseClient(app.origin);
  await client.ready;

  const first = await client.waitFor(() => true);
  assert.ok(first.mining, "initial snapshot carries full state");
  assert.equal(first.logsFrom >= 1, true);

  app.minerManager.pushLog("hello from the miner", "info");
  app.sseHub.broadcast();

  const withLog = await client.waitFor(s => s.miner.logs.some(l => l.text === "hello from the miner"));
  assert.equal(withLog.logCount, first.logCount + 1);

  client.close();
  await delay(50);
  assert.equal(app.sseHub.size, 0, "disconnect is reaped");
});

test("subscriber count gates GPU polling and log fan-out", async t => {
  const app = await startServer();
  t.after(() => app.close());

  assert.equal(app.gpuManager.active, false);
  assert.equal(app.minerManager.parsingEnabled, false);

  const client = sseClient(app.origin);
  await client.ready;
  await client.waitFor(() => true);

  assert.equal(app.gpuManager.active, true, "polling starts with the first subscriber");
  assert.equal(app.minerManager.parsingEnabled, true);

  client.close();
  await delay(80);

  assert.equal(app.gpuManager.active, false, "polling stops with the last subscriber");
  assert.equal(app.gpuManager.timer, null);
  assert.equal(app.minerManager.parsingEnabled, false);
});

test("rapid stream reconnects are throttled instead of piling up", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const clients = [];
  let throttled = false;

  for (let i = 0; i < 5; i++) {
    const c = sseClient(app.origin);
    try {
      await c.ready;
      clients.push(c);
    } catch (err) {
      throttled = /429/.test(String(err.message));
      break;
    }
  }
  assert.ok(throttled, "a reconnect storm must be rate limited");
  assert.ok(app.sseHub.size <= LIMITS.MAX_SSE_CLIENTS);

  // While throttled, /api/status still answers and tells the UI when to retry.
  const status = await request(app.origin, "/api/status");
  assert.equal(status.status, 200);
  assert.ok(status.json().streamRetryAfterMs > 0, "client is told how long to wait");

  for (const c of clients) c.close();
  await delay(80);
  assert.equal(app.sseHub.size, 0);
});

test("an abruptly killed browser never leaves a subscriber behind", async t => {
  const app = await startServer();
  t.after(() => app.close());

  for (let round = 0; round < 3; round++) {
    const client = sseClient(app.origin);
    await client.ready;
    await client.waitFor(() => true);
    client.close(); // destroys the socket without a graceful close
  }
  await delay(150);

  assert.equal(app.sseHub.size, 0);
  assert.equal(app.sseHub.heartbeatTimer, null, "no orphaned heartbeat timer");
  assert.equal(app.gpuManager.active, false);
});
