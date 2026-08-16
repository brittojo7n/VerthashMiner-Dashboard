#!/usr/bin/env node
/*
 * Regression suite. Zero dependencies, run with: node test/run.js
 *
 * Covers parser classification, state projection, SSE fan-out, rate limiting,
 * auth and the HTTP surface. Every fixture below mirrors real VerthashMiner
 * output (see MINER-LOG-FORMATS.md).
 */
"use strict";

const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "testsecret0123456789";

let passed = 0, failed = 0, current = "";
const groups = [];

function describe(name, fn) { groups.push([name, fn]); }
function it(name, fn) { current = name; return fn; }

const tests = [];
function test(group, name, fn) { tests.push({ group, name, fn }); }

// ── fixtures ────────────────────────────────────────────────────────────────
// applog(): "[%Y-%m-%d %H:%M:%S] %-5s %s\n"  (src/vhCore/Util.cpp)
const log = (prio, msg) => `[2026-08-17 12:00:00] ${prio.padEnd(5)} ${msg}`;

const FIXTURES = {
  cuHash: log("INFO", "cu_device(0): err:0, temp:64C, power:120W, fan:55%, hashrate: 12.34 kH/s"),
  cuHashMemErr: log("INFO", "cu_device(0): err:7, temp:78C, power:120W, hashrate: 12.10 kH/s"),
  clHash: log("INFO", "cl_device(0): temp:64C, hashrate: 9.50 kH/s"),
  accepted: log("INFO", "accepted: 5/6 (83.33%), total hashrate: 23.44 kH/s"),
  acceptedPending: log("INFO", "accepted: 1/1 (100.00%), total hashrate: (pending...)"),
  difficulty: log("INFO", "Stratum difficulty set to 0.03125"),
  stratumStart: log("INFO", "Starting Stratum on stratum+tcp://pool:6144"),
  stratumTimeout: log("ERROR", "Stratum connection timed out"),
  stratumFailed: log("ERROR", "Stratum connection failed: Connection refused"),
  stratumInterrupted: log("ERROR", "Stratum connection interrupted"),
  cudaFatal: log("ERROR", "CUDA error: out of memory"),
  standaloneErrors: log("INFO", "summary errors: 4 encountered"),
  deviceList: [
    "OpenCL devices:",
    "\tIndex: 0. Name: NVIDIA GeForce RTX 3070",
    "\t          pcieId: 01:00:0",
    "",
    "CUDA devices:",
    "\tIndex: 0. Name: NVIDIA GeForce RTX 3070. pcieId: 01:00:0",
    "\tIndex: 1. Name: NVIDIA GeForce RTX 3060. pcieId: 02:00:0",
    ""
  ].join("\n"),
  smiCsv:
    "NVIDIA GeForce RTX 3070, 64, 120.50, 98, 1800, 7000, 512, 8192, P2, 00000000:01:00.0\n" +
    "NVIDIA GeForce RTX 3060, 61, 110.00, 97, 1750, 6800, 480, 12288, P2, 00000000:02:00.0"
};

// ── parser ──────────────────────────────────────────────────────────────────
const { parseMinerLine } = require(path.join(ROOT, "src/parser"));
const { createState, formatStatsSnapshot } = require(path.join(ROOT, "src/state"));
const { STATUS } = require(path.join(ROOT, "src/constants"));

const mining = () => {
  const s = createState("", 50);
  s.miner.running = true;
  s.mining.status = STATUS.MINING;
  return s;
};
const typeOf = (line, state) => {
  let t = null;
  parseMinerLine(line, state || mining(), (_l, ty) => { t = ty; });
  return t;
};

test("parser", "device err:N counter is telemetry, not an error", () => {
  assert.strictEqual(typeOf(FIXTURES.cuHashMemErr), "warn");
});
test("parser", "device err:0 is normal accent output", () => {
  assert.strictEqual(typeOf(FIXTURES.cuHash), "accent");
});
test("parser", "standalone 'errors: N' still classifies as error", () => {
  assert.strictEqual(typeOf(FIXTURES.standaloneErrors), "error");
});
test("parser", "memory errors do not stop hashrate parsing", () => {
  const s = mining();
  parseMinerLine(FIXTURES.cuHashMemErr, s, () => {});
  assert.strictEqual(s.mining.gpuHashrates.cu_0, 12.10);
  assert.strictEqual(s.mining.status, STATUS.MINING);
});
for (const [k, name] of [
  ["stratumTimeout", "timeout"], ["stratumFailed", "failure"], ["stratumInterrupted", "interruption"]
]) {
  test("parser", `stratum ${name} -> DISCONNECTED`, () => {
    const s = mining();
    parseMinerLine(FIXTURES[k], s, () => {});
    assert.strictEqual(s.mining.status, STATUS.DISCONNECTED);
  });
}
test("parser", "recovers to MINING after reconnect", () => {
  const s = mining();
  parseMinerLine(FIXTURES.stratumTimeout, s, () => {});
  parseMinerLine(FIXTURES.cuHash, s, () => {});
  parseMinerLine(FIXTURES.cuHash, s, () => {});
  assert.strictEqual(s.mining.status, STATUS.MINING);
  assert.strictEqual(s.miner.lastError, "");
});
test("parser", "genuine CUDA fault -> CRASHED", () => {
  const s = mining();
  parseMinerLine(FIXTURES.cudaFatal, s, () => {});
  assert.strictEqual(s.mining.status, STATUS.CRASHED);
});
test("parser", "accepted line updates share counters", () => {
  const s = mining();
  parseMinerLine(FIXTURES.accepted, s, () => {});
  assert.strictEqual(s.mining.accepted, 5);
  assert.strictEqual(s.mining.submitted, 6);
  assert.strictEqual(s.mining.rejected, 1);
  assert.strictEqual(s.mining.hashrateKHs, 23.44);
});
test("parser", "'(pending...)' never becomes NaN", () => {
  const s = mining();
  parseMinerLine(FIXTURES.acceptedPending, s, () => {});
  assert.strictEqual(s.mining.hashrateKHs, null);
});
test("parser", "difficulty parsed from 'Stratum difficulty set to %g'", () => {
  const s = mining();
  parseMinerLine(FIXTURES.difficulty, s, () => {});
  assert.strictEqual(s.mining.difficulty, 0.03125);
});
test("parser", "total hashrate accumulates across devices", () => {
  const s = mining();
  const l1 = log("INFO", "cu_device(0): hashrate: 10.00 kH/s");
  const l2 = log("INFO", "cu_device(1): hashrate: 5.00 kH/s");
  for (const l of [l1, l2, l1, l2]) parseMinerLine(l, s, () => {});
  assert.strictEqual(s.mining.hashrateKHs, 15);
});
test("parser", "ANSI escape codes are stripped", () => {
  const s = mining();
  let text = null;
  parseMinerLine("\u001b[32m" + FIXTURES.cuHash + "\u001b[0m", s, l => { text = l; });
  assert.ok(!/\u001b/.test(text));
});

// ── state ───────────────────────────────────────────────────────────────────
test("state", "cl_ hashrate resolves when no cu_ key exists", () => {
  const s = createState("w", 50);
  s.gpu = [{ index: 0, pciBusId: "01:00:0" }];
  s.mining.pciMap = { "01:00:0": "0" };
  s.mining.gpuHashrates = { cl_0: 9.5 };
  assert.strictEqual(formatStatsSnapshot(s).gpu[0].hashrate, 9.5);
});
test("state", "cu_ takes precedence over cl_", () => {
  const s = createState("w", 50);
  s.gpu = [{ index: 0, pciBusId: "01:00:0" }];
  s.mining.pciMap = { "01:00:0": "0" };
  s.mining.gpuHashrates = { cu_0: 12.3, cl_0: 9.5 };
  assert.strictEqual(formatStatsSnapshot(s).gpu[0].hashrate, 12.3);
});
test("state", "gpuError is exposed to the client", () => {
  const s = createState("w", 50);
  s.gpuError = "spawn nvidia-smi.exe ENOENT";
  assert.strictEqual(formatStatsSnapshot(s).gpuError, "spawn nvidia-smi.exe ENOENT");
});
test("state", "log ring buffer never exceeds capacity", () => {
  const s = createState("", 15);
  for (let i = 0; i < 200; i++) s.miner.logs.push("line " + i, "info");
  const out = s.miner.logs.toJSON();
  assert.strictEqual(out.length, 15);
  assert.strictEqual(out[14].text, "line 199");
  assert.ok(out[0].id < out[14].id, "ids must increase in order");
});
test("state", "acceptedRatio is null before any submission", () => {
  assert.strictEqual(formatStatsSnapshot(createState("", 50)).acceptedRatio, null);
});
test("state", "uptime is zero while the miner is stopped", () => {
  assert.strictEqual(formatStatsSnapshot(createState("", 50)).uptimeSeconds, 0);
});

// ── gpu ─────────────────────────────────────────────────────────────────────
const { parseSmiOutput } = require(path.join(ROOT, "src/gpu"));
test("gpu", "nvidia-smi CSV parses into normalised records", () => {
  const g = parseSmiOutput(FIXTURES.smiCsv);
  assert.strictEqual(g.length, 2);
  assert.strictEqual(g[0].name, "NVIDIA GeForce RTX 3070");
  assert.strictEqual(g[0].temperatureC, 64);
  assert.strictEqual(g[0].powerW, 120.5);
  assert.strictEqual(g[0].memoryTotalMB, 8192);
});
test("gpu", "pci.bus_id normalises to the miner's pcieId form", () => {
  const g = parseSmiOutput(FIXTURES.smiCsv);
  assert.strictEqual(g[0].pciBusId, "01:00:0");
  assert.strictEqual(g[1].pciBusId, "02:00:0");
});
test("gpu", "empty nvidia-smi output yields no devices", () => {
  assert.deepStrictEqual(parseSmiOutput("   \n  "), []);
});

// ── miner: device list ──────────────────────────────────────────────────────
const { parseCudaDeviceList } = require(path.join(ROOT, "src/miner"));
test("miner", "--device-list maps CUDA pcieId -> device index", () => {
  const map = {};
  parseCudaDeviceList(FIXTURES.deviceList, map);
  assert.deepStrictEqual(map, { "01:00:0": "0", "02:00:0": "1" });
});
test("miner", "end-to-end PCI join attributes hashrate per GPU", () => {
  const map = {};
  parseCudaDeviceList(FIXTURES.deviceList, map);
  const s = createState("w", 50);
  s.gpu = parseSmiOutput(FIXTURES.smiCsv);
  s.mining.pciMap = map;
  s.mining.gpuHashrates = { cu_0: 12.34, cu_1: 11.1 };
  const out = formatStatsSnapshot(s).gpu;
  assert.strictEqual(out[0].hashrate, 12.34);
  assert.strictEqual(out[1].hashrate, 11.1);
});

// ── sse ─────────────────────────────────────────────────────────────────────
const { SseHub } = require(path.join(ROOT, "src/sse"));
const fakeRes = () => ({
  written: [], ended: false, destroyed: false, writableEnded: false,
  socket: { destroyed: false, writable: true },
  write(c) { this.written.push(c); return true; },
  end() { this.ended = true; }, once() {}, on() {}
});

test("sse", "throttles rather than debounces under continuous updates", async () => {
  const state = createState("w", 50);
  const hub = new SseHub({ state, onSubscriberChange() {} });
  const res = fakeRes();
  hub.clients.add(res);
  const iv = setInterval(() => { state.dirty = true; hub.broadcast(); }, 20);
  await new Promise(r => setTimeout(r, 600));
  clearInterval(iv);
  hub.closeAll();
  assert.ok(res.written.length >= 5, `expected sustained frames, got ${res.written.length}`);
});
test("sse", "reaps dead clients before rejecting at the cap", () => {
  const state = createState("w", 50);
  const hub = new SseHub({ state, onSubscriberChange() {} });
  for (let i = 0; i < 4; i++) {
    const d = fakeRes();
    d.writableEnded = true; d.destroyed = true;
    hub.clients.add(d);
  }
  const live = fakeRes();
  hub.handleConnection({ on() {} }, live);
  assert.ok(hub.clients.has(live), "a live client must be admitted after reaping");
  hub.closeAll();
});
test("sse", "enforces the cap when all clients are alive", () => {
  const state = createState("w", 50);
  const hub = new SseHub({ state, onSubscriberChange() {} });
  const live = [];
  for (let i = 0; i < 4; i++) { const r = fakeRes(); live.push(r); hub.clients.add(r); }
  const extra = fakeRes();
  hub.handleConnection({ on() {} }, extra);
  assert.ok(!hub.clients.has(extra), "5th live client must be rejected");
  assert.ok(extra.written.join("").includes("Too many clients"));
  hub.closeAll();
});
test("sse", "subscriber count drives the change callback", () => {
  const state = createState("w", 50);
  const seen = [];
  const hub = new SseHub({ state, onSubscriberChange: n => seen.push(n) });
  hub.handleConnection({ on() {} }, fakeRes());
  hub.closeAll();
  assert.deepStrictEqual(seen, [1, 0]);
});

// ── rate limiter ────────────────────────────────────────────────────────────
const { createRateLimiter } = require(path.join(ROOT, "src/ratelimit"));
test("ratelimit", "allows up to the configured budget", () => {
  const allow = createRateLimiter(3, 1000);
  assert.strictEqual(allow("ip"), 0);
  assert.strictEqual(allow("ip"), 0);
  assert.strictEqual(allow("ip"), 0);
  assert.ok(allow("ip") > 0, "4th call must be limited");
});
test("ratelimit", "applies a flat penalty on first breach", () => {
  const allow = createRateLimiter(2, 1000, 5000);
  allow("ip"); allow("ip");
  const first = allow("ip");
  assert.ok(first > 4000, `expected ~5000ms penalty, got ${first}`);
});
test("ratelimit", "penalty is applied once and cannot be extended", () => {
  const allow = createRateLimiter(1, 1000, 5000);
  allow("ip");
  const a = allow("ip");
  const b = allow("ip");
  assert.ok(b <= a, "repeat breaches must not push the deadline out");
});
test("ratelimit", "buckets are isolated per client", () => {
  const allow = createRateLimiter(1, 1000);
  assert.strictEqual(allow("a"), 0);
  assert.strictEqual(allow("b"), 0);
});
test("ratelimit", "bucket map stays bounded", () => {
  const allow = createRateLimiter(1, 1000);
  for (let i = 0; i < 500; i++) allow("ip" + i);
  assert.ok(true);
});

// ── http surface ────────────────────────────────────────────────────────────
const { createHttpServer } = require(path.join(ROOT, "src/http"));

function withServer(config, fn) {
  const state = createState("w", 50);
  const hub = new SseHub({ state, onSubscriberChange() {} });
  const miner = { requestAction() {}, start() {}, stop() { return Promise.resolve(); } };
  const server = createHttpServer({ config, state, sseHub: hub, minerManager: miner });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", async () => {
      const port = server.address().port;
      try { await fn(port); resolve(); }
      catch (e) { reject(e); }
      finally { hub.closeAll(); server.closeAllConnections(); server.close(); }
    });
  });
}

const req = (port, pathname, opts = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port, path: pathname, method: opts.method || "GET", headers: opts.headers || {} }, res => {
    let body = "";
    res.on("data", c => { body += c; });
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  r.on("error", reject);
  if (opts.body) r.write(opts.body);
  r.end();
});

const OPEN = { PASSPHRASE: "", SESSION_SECRET: "s3cret", MINER_ARGS: [], MAX_LOGS: 50 };
const LOCKED = { PASSPHRASE: "hunter2", SESSION_SECRET: "s3cret", MINER_ARGS: [], MAX_LOGS: 50 };

test("http", "health endpoint responds", () => withServer(OPEN, async port => {
  const r = await req(port, "/health");
  assert.strictEqual(r.status, 200);
}));
test("http", "serves the dashboard shell", () => withServer(OPEN, async port => {
  const r = await req(port, "/");
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.includes("VerthashMiner"));
  assert.strictEqual(r.headers["cache-control"], "no-cache");
}));
test("http", "unknown routes 404", () => withServer(OPEN, async port => {
  assert.strictEqual((await req(port, "/nope")).status, 404);
}));
test("http", "status returns a JSON snapshot when unlocked", () => withServer(OPEN, async port => {
  const r = await req(port, "/api/status");
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok("mining" in j && "gpu" in j && "gpuError" in j);
}));
test("http", "API is protected when a passphrase is set", () => withServer(LOCKED, async port => {
  assert.strictEqual((await req(port, "/api/status")).status, 401);
  assert.strictEqual((await req(port, "/events")).status, 401);
}));
test("http", "wrong passphrase is rejected", () => withServer(LOCKED, async port => {
  const r = await req(port, "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase: "wrong" })
  });
  assert.strictEqual(r.status, 401);
}));
test("http", "non-string passphrase is rejected, not crashed", () => withServer(LOCKED, async port => {
  const r = await req(port, "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase: 12345 })
  });
  assert.strictEqual(r.status, 401);
}));
test("http", "correct passphrase issues an HttpOnly session cookie", () => withServer(LOCKED, async port => {
  const r = await req(port, "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase: "hunter2" })
  });
  assert.strictEqual(r.status, 200);
  const cookie = String(r.headers["set-cookie"][0]);
  assert.ok(cookie.includes("HttpOnly"));
  assert.ok(cookie.includes("SameSite=Strict"));
}));
test("http", "session cookie unlocks the API", () => withServer(LOCKED, async port => {
  const login = await req(port, "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase: "hunter2" })
  });
  const cookie = String(login.headers["set-cookie"][0]).split(";")[0];
  const r = await req(port, "/api/status", { headers: { cookie } });
  assert.strictEqual(r.status, 200);
}));
test("http", "rate limited responses carry Retry-After and JSON detail", () => withServer(OPEN, async port => {
  let limited = null;
  for (let i = 0; i < 12 && !limited; i++) {
    const r = await req(port, "/api/status");
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, "expected a 429 within the burst");
  assert.ok(Number(limited.headers["retry-after"]) >= 1);
  const j = JSON.parse(limited.body);
  assert.strictEqual(j.error, "rate_limited");
  assert.ok(Number.isFinite(j.retryAfterMs));
}));
test("http", "malformed login body yields 400", () => withServer(LOCKED, async port => {
  const r = await req(port, "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json"
  });
  assert.strictEqual(r.status, 400);
}));
test("http", "miner control actions are accepted", () => withServer(OPEN, async port => {
  const r = await req(port, "/api/miner/start", { method: "POST" });
  assert.strictEqual(r.status, 200);
}));
test("http", "unknown miner action is not routed", () => withServer(OPEN, async port => {
  assert.strictEqual((await req(port, "/api/miner/destroy", { method: "POST" })).status, 404);
}));
test("http", "query strings do not defeat route matching", () => withServer(OPEN, async port => {
  assert.strictEqual((await req(port, "/health?x=1")).status, 200);
}));

// ── runner ──────────────────────────────────────────────────────────────────
(async () => {
  const byGroup = new Map();
  for (const t of tests) {
    if (!byGroup.has(t.group)) byGroup.set(t.group, []);
    byGroup.get(t.group).push(t);
  }
  for (const [group, list] of byGroup) {
    console.log(`\n  ${group}`);
    for (const t of list) {
      try {
        await t.fn();
        passed++;
        console.log(`    \u2713 ${t.name}`);
      } catch (err) {
        failed++;
        console.log(`    \u2717 ${t.name}\n        ${err.message}`);
      }
    }
  }
  console.log(`\n  ${passed} passing, ${failed} failing\n`);
  process.exit(failed ? 1 : 0);
})();
