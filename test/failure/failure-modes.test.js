"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const net = require("node:net");

const { startServer, request, sseClient, delay, ROOT } = require("../helpers/harness");
const { createState, formatStatsSnapshot } = require("../../src/state");
const { parseMinerLine } = require("../../src/parser");
const { MALFORMED_LINES } = require("../helpers/fixtures");

const XHR = { "X-Requested-With": "XMLHttpRequest" };

test("the miner being SIGKILLed out from under us is reported, not fatal", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const client = sseClient(app.origin);
  await client.ready;
  await client.waitFor(() => true);

  await app.minerManager.start();
  const pid = app.state.miner.pid;
  process.kill(pid, "SIGKILL");

  const gone = await client.waitFor(s => s.miner.signal === "SIGKILL", 8000);
  assert.equal(gone.miner.running, false);
  assert.equal(gone.mining.status, "CRASHED");
  assert.equal((await request(app.origin, "/health")).status, 200, "dashboard survived");

  client.close();
});

test("a miner that writes garbage bytes cannot break the parser", async t => {
  const app = await startServer({ mock: { mode: "binary" } });
  t.after(() => app.close());

  await app.minerManager.start();
  await delay(400);

  assert.equal(app.state.miner.running, true);
  assert.equal((await request(app.origin, "/api/status")).status, 200);
});

test("a miner that never emits a newline cannot exhaust memory", async t => {
  const app = await startServer({ mock: { mode: "nonewline" } });
  t.after(() => app.close());

  const before = process.memoryUsage().heapUsed;
  await app.minerManager.start();
  await delay(1200);
  const growth = process.memoryUsage().heapUsed - before;

  assert.ok(growth < 64 * 1024 * 1024, `heap grew ${(growth / 1048576).toFixed(1)} MB`);
  assert.equal((await request(app.origin, "/health")).status, 200);
});

test("nvidia-smi failures degrade telemetry only", async t => {
  const app = await startServer({
    smi: (_b, _a, _o, cb) => cb(Object.assign(new Error("spawn nvidia-smi ENOENT"), { code: "ENOENT" }))
  });
  t.after(() => app.close());

  const client = sseClient(app.origin);
  await client.ready;
  const snapshot = await client.waitFor(s => s.gpuError.length > 0, 8000);

  assert.match(snapshot.gpuError, /ENOENT/);
  assert.deepEqual(snapshot.gpu, [], "no fabricated telemetry");

  await app.minerManager.start();
  const mining = await client.waitFor(s => s.mining.hashrateKHs > 0, 15000);
  assert.ok(mining.mining.hashrateKHs > 0, "mining metrics keep flowing without a GPU probe");

  client.close();
});

test("nvidia-smi hanging does not stall the event loop or the stream", async t => {
  let released = null;
  const app = await startServer({
    smi: (_b, _a, _o, cb) => {
      released = cb;
    }
  });
  t.after(() => {
    if (released) released(new Error("cancelled"));
    return app.close();
  });

  const client = sseClient(app.origin);
  await client.ready;
  await client.waitFor(() => true);

  app.minerManager.pushLog("still alive", "info");
  app.sseHub.broadcast();
  const snapshot = await client.waitFor(s => s.miner.logs.some(l => l.text === "still alive"), 4000);
  assert.ok(snapshot, "SSE keeps flowing while nvidia-smi is stuck");

  client.close();
});

test("a truncated nvidia-smi response yields nulls, never wrong numbers", async t => {
  const app = await startServer({
    smi: (_b, _a, _o, cb) => cb(null, "NVIDIA GeForce RTX 3060, 63\n")
  });
  t.after(() => app.close());

  const client = sseClient(app.origin);
  await client.ready;
  const snapshot = await client.waitFor(s => s.gpu.length > 0, 8000);

  assert.equal(snapshot.gpu[0].temperatureC, 63);
  assert.equal(snapshot.gpu[0].powerW, null);
  assert.equal(snapshot.gpu[0].memoryTotalMB, null);

  client.close();
});

test("a snapshot is always serialisable, even mid-corruption", () => {
  const state = createState("w", 20);
  state.miner.running = true;

  for (const line of MALFORMED_LINES) parseMinerLine(line, state);
  // Simulate a partially populated telemetry array.
  state.gpu = [{ index: 0, name: undefined, pciBusId: undefined }];

  const snapshot = formatStatsSnapshot(state);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
  assert.equal(Number.isNaN(snapshot.mining.hashrateKHs), false);
});

test("half-open and abandoned sockets do not accumulate", async t => {
  const app = await startServer();
  t.after(() => app.close());

  for (let i = 0; i < 25; i++) {
    await new Promise(resolve => {
      const socket = net.connect(app.port, "127.0.0.1", () => {
        socket.write("GET /health HTTP/1.1\r\nHost: localhost\r\n");
        socket.destroy(); // never finishes the request
        resolve();
      });
      socket.on("error", resolve);
    });
  }
  await delay(200);
  assert.equal((await request(app.origin, "/health")).status, 200);
});

test("garbage on the socket is answered with 400, not a crash", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const reply = await new Promise(resolve => {
    const socket = net.connect(app.port, "127.0.0.1", () => {
      socket.write("\x00\x01\x02 NOT-HTTP /\r\n\r\n");
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => (data += chunk));
    socket.on("close", () => resolve(data));
    socket.on("error", () => resolve(data));
  });

  assert.ok(reply === "" || /400 Bad Request/.test(reply), `unexpected reply: ${reply.slice(0, 40)}`);
  assert.equal((await request(app.origin, "/health")).status, 200);
});

test("oversized headers are rejected without taking the server down", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const res = await request(app.origin, "/health", {
    headers: { "X-Filler": "a".repeat(32 * 1024) }
  }).catch(err => ({ status: `error:${err.code}` }));

  assert.ok(res.status === 431 || res.status === 400 || String(res.status).startsWith("error"));
  assert.equal((await request(app.origin, "/health")).status, 200);
});

test("the supervisor keeps the miner alive through a dashboard fault", async t => {
  const app = await startServer();
  t.after(() => app.close());

  await app.minerManager.start();
  const pid = app.state.miner.pid;

  // A broken subscriber callback must not propagate into the miner pipeline.
  const original = app.sseHub.onSubscriberChange;
  app.sseHub.onSubscriberChange = () => {
    throw new Error("synthetic UI fault");
  };
  const client = sseClient(app.origin);
  await client.ready.catch(() => {});
  await delay(150);
  app.sseHub.onSubscriberChange = original;

  assert.equal(app.state.miner.running, true, "miner still running");
  assert.doesNotThrow(() => process.kill(pid, 0), "child untouched");
  client.close();
});

test("server.js refuses to start with an insecure configuration", async () => {
  const run = env =>
    new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let out = "";
      child.stdout.on("data", d => (out += d));
      child.stderr.on("data", d => (out += d));
      child.on("close", code => resolve({ code, out }));
      setTimeout(() => child.kill("SIGKILL"), 8000).unref();
    });

  const noSecret = await run({
    SESSION_SECRET: "",
    HOST: "127.0.0.1",
    PORT: "0",
    MINER_CWD: "",
    MINER_ARGS: ""
  });
  assert.equal(noSecret.code, 1);
  assert.match(noSecret.out, /SESSION_SECRET/);

  const lanNoPass = await run({
    SESSION_SECRET: "x".repeat(64),
    PASSPHRASE: "",
    HOST: "0.0.0.0",
    PORT: "0",
    MINER_CWD: "",
    MINER_ARGS: ""
  });
  assert.equal(lanNoPass.code, 1);
  assert.match(lanNoPass.out, /PASSPHRASE/);
});

test("SIGTERM shuts the whole process down promptly", async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: {
      ...process.env,
      SESSION_SECRET: "x".repeat(64),
      HOST: "127.0.0.1",
      PORT: "0",
      MINER_CWD: "",
      MINER_ARGS: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  await new Promise(resolve => {
    child.stdout.once("data", resolve);
    setTimeout(resolve, 3000).unref();
  });

  const started = Date.now();
  child.kill("SIGTERM");
  const code = await new Promise(resolve => child.on("close", resolve));

  assert.ok(Date.now() - started < 8000, "exited within the shutdown watchdog");
  assert.ok(code === 0 || code === null, `exit code ${code}`);
});

test("a second instance on a taken port fails fast with a clear message", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: {
      ...process.env,
      SESSION_SECRET: "x".repeat(64),
      HOST: "127.0.0.1",
      PORT: String(app.port),
      MINER_CWD: "",
      MINER_ARGS: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let out = "";
  child.stdout.on("data", d => (out += d));
  child.stderr.on("data", d => (out += d));
  const code = await new Promise(resolve => {
    child.on("close", resolve);
    setTimeout(() => child.kill("SIGKILL"), 8000).unref();
  });

  assert.equal(code, 1);
  assert.match(out, /already in use/i);
});
