"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createState, formatStatsSnapshot } = require("../../src/state");
const { parseMinerLine } = require("../../src/parser");
const { startServer, sseClient, request, delay, markRunning } = require("../helpers/harness");
const { generateLines, SMI_OUTPUT } = require("../helpers/fixtures");

const MB = 1024 * 1024;

function heapAfterGc() {
  if (global.gc) {
    global.gc();
    global.gc();
  }
  return process.memoryUsage().heapUsed;
}

/** Measures wall time and CPU time of an async section. */
async function measure(fn) {
  const cpu0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const cpu = process.cpuUsage(cpu0);
  return { value, ms, cpuMs: (cpu.user + cpu.system) / 1000 };
}

test("parser throughput: 50k console lines stay well inside the budget", async t => {
  const lines = generateLines(50_000);
  const state = markRunning(createState("w", 50));

  const { ms } = await measure(() => {
    for (const line of lines) parseMinerLine(line, state);
  });

  const perLineUs = (ms * 1000) / lines.length;
  t.diagnostic(`50k lines in ${ms.toFixed(0)} ms (${perLineUs.toFixed(2)} us/line)`);

  // A real rig emits a handful of lines per second; 10 us/line is already
  // four orders of magnitude of headroom.
  assert.ok(perLineUs < 10, `parser too slow: ${perLineUs.toFixed(2)} us/line`);
  assert.ok(state.mining.submitted > 0, "the corpus was actually parsed");
});

test("parsing is allocation-stable: the log buffer bounds the heap", async t => {
  const state = markRunning(createState("w", 50));
  const lines = generateLines(20_000);

  for (const line of lines.slice(0, 2000)) parseMinerLine(line, state, (x, y) => state.miner.logs.push(x, y));
  const before = heapAfterGc();

  for (const line of lines) parseMinerLine(line, state, (x, y) => state.miner.logs.push(x, y));
  const growth = heapAfterGc() - before;

  t.diagnostic(`heap growth over 20k lines: ${(growth / MB).toFixed(2)} MB`);
  assert.ok(growth < 8 * MB, `heap grew ${(growth / MB).toFixed(2)} MB`);
  assert.equal(state.miner.logs.toJSON().length, 50, "ring buffer holds the cap");
});

test("snapshot projection cost is flat and small", async t => {
  const state = markRunning(createState("w", 500));
  for (const line of generateLines(2000)) parseMinerLine(line, state, (x, y) => state.miner.logs.push(x, y));
  state.gpu = [
    { index: 0, name: "A", pciBusId: "01:00:0" },
    { index: 1, name: "B", pciBusId: "08:00:0" }
  ];

  const full = await measure(() => {
    for (let i = 0; i < 2000; i++) JSON.stringify(formatStatsSnapshot(state));
  });
  const delta = await measure(() => {
    for (let i = 0; i < 2000; i++) {
      JSON.stringify(formatStatsSnapshot(state, { logsSince: state.miner.logs.seq }));
    }
  });

  t.diagnostic(
    `full snapshot ${(full.ms / 2000).toFixed(3)} ms, delta ${(delta.ms / 2000).toFixed(3)} ms`
  );
  assert.ok(full.ms / 2000 < 5, "full projection must stay sub-5ms");
  assert.ok(delta.ms < full.ms, "delta must be cheaper than a full replay");
});

test("delta frames cut the streamed payload by an order of magnitude", async t => {
  const state = markRunning(createState("w", 500));
  for (const line of generateLines(2000)) parseMinerLine(line, state, (x, y) => state.miner.logs.push(x, y));

  const fullBytes = Buffer.byteLength(JSON.stringify(formatStatsSnapshot(state)));
  state.miner.logs.push("one new line", "info");
  const deltaBytes = Buffer.byteLength(
    JSON.stringify(formatStatsSnapshot(state, { logsSince: state.miner.logs.seq - 1 }))
  );

  t.diagnostic(`full frame ${fullBytes} B, delta frame ${deltaBytes} B`);
  assert.ok(deltaBytes * 5 < fullBytes, `delta ${deltaBytes} vs full ${fullBytes}`);
});

test("idle dashboard performs no work at all", async t => {
  const app = await startServer({ smi: (_b, _a, _o, cb) => cb(null, SMI_OUTPUT) });
  t.after(() => app.close());

  await app.minerManager.start();
  await delay(300);

  // No subscribers: no polling, no fan-out, no timers.
  assert.equal(app.gpuManager.active, false);
  assert.equal(app.gpuManager.timer, null);
  assert.equal(app.sseHub.size, 0);
  assert.equal(app.sseHub.heartbeatTimer, null);
  assert.equal(app.sseHub.bcastTimer, null);
  assert.equal(app.minerManager.parsingEnabled, false);

  const idle = await measure(() => delay(1500));
  const cpuPercent = (idle.cpuMs / idle.ms) * 100;
  t.diagnostic(`idle CPU while the miner streams: ${cpuPercent.toFixed(3)} %`);
  assert.ok(cpuPercent < 5, `idle CPU too high: ${cpuPercent.toFixed(2)} %`);
});

test("attached dashboard stays lightweight under a live stream", async t => {
  const app = await startServer({ smi: (_b, _a, _o, cb) => cb(null, SMI_OUTPUT) });
  t.after(() => app.close());

  const client = sseClient(app.origin);
  await client.ready;
  await client.waitFor(() => true);
  await app.minerManager.start();
  await client.waitFor(s => s.mining.hashrateKHs > 0, 15000);

  const active = await measure(() => delay(2000));
  const cpuPercent = (active.cpuMs / active.ms) * 100;
  const rssMb = process.memoryUsage().rss / MB;

  t.diagnostic(`active CPU (server + test client + mock miner): ${cpuPercent.toFixed(2)} %`);
  t.diagnostic(`process RSS: ${rssMb.toFixed(1)} MB`);
  assert.ok(cpuPercent < 25, `active CPU too high: ${cpuPercent.toFixed(2)} %`);

  client.close();
});

test("a firehose miner cannot outrun the dashboard", async t => {
  const app = await startServer({ mock: { mode: "flood", rate: 1000, total: 40_000 } });
  t.after(() => app.close());

  const client = sseClient(app.origin);
  await client.ready;
  await client.waitFor(() => true);

  const before = heapAfterGc();
  await app.minerManager.start();
  const run = await measure(() => delay(3000));
  const growth = heapAfterGc() - before;

  t.diagnostic(
    `flood: ${app.state.miner.logs.seq} lines, ` +
      `${((run.cpuMs / run.ms) * 100).toFixed(1)} % CPU, ` +
      `heap +${(growth / MB).toFixed(1)} MB`
  );

  assert.ok(app.state.miner.logs.seq > 1000, "lines were actually processed");
  assert.ok(growth < 48 * MB, `heap grew ${(growth / MB).toFixed(1)} MB under flood`);
  assert.equal((await request(app.origin, "/health")).status, 200, "still responsive");

  // Frames must be coalesced: far fewer SSE frames than console lines.
  assert.ok(
    client.snapshots.length < app.state.miner.logs.seq / 5,
    `too many frames: ${client.snapshots.length} for ${app.state.miner.logs.seq} lines`
  );

  client.close();
});

test("repeated connect/disconnect cycles leak neither handles nor memory", async t => {
  const app = await startServer({ smi: (_b, _a, _o, cb) => cb(null, SMI_OUTPUT) });
  t.after(() => app.close());

  const before = heapAfterGc();
  for (let i = 0; i < 20; i++) {
    const client = sseClient(app.origin);
    try {
      await client.ready;
      await client.waitFor(() => true, 3000);
    } catch {
      /* rate limited: still a valid cycle */
    }
    client.close();
    await delay(60);
  }
  await delay(300);
  const growth = heapAfterGc() - before;

  t.diagnostic(`heap growth over 20 reconnects: ${(growth / MB).toFixed(2)} MB`);
  assert.equal(app.sseHub.size, 0);
  assert.equal(app.sseHub.heartbeatTimer, null);
  assert.equal(app.gpuManager.active, false);
  assert.ok(growth < 12 * MB, `heap grew ${(growth / MB).toFixed(2)} MB`);
});

test("a request storm is throttled instead of amplified", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: 200 }, () => request(app.origin, "/api/status").catch(() => ({ status: 0 })))
  );
  const elapsed = Date.now() - started;

  const ok = results.filter(r => r.status === 200).length;
  const limited = results.filter(r => r.status === 429).length;
  t.diagnostic(`200 requests in ${elapsed} ms -> ${ok} served, ${limited} throttled`);

  assert.ok(limited > 100, "the limiter must absorb the storm");
  assert.ok(elapsed < 10_000, "no queue build-up");
  assert.equal((await request(app.origin, "/health")).status, 200);
});

test("GPU polling rate is bounded no matter how many clients attach", async t => {
  let calls = 0;
  const app = await startServer({
    smi: (_b, _a, _o, cb) => {
      calls++;
      cb(null, SMI_OUTPUT);
    },
    env: { GPU_POLL_MS: "3000" }
  });
  t.after(() => app.close());

  const clients = [];
  for (let i = 0; i < 3; i++) {
    const c = sseClient(app.origin);
    try {
      await c.ready;
      clients.push(c);
    } catch {
      /* throttled */
    }
  }
  await delay(1500);

  t.diagnostic(`nvidia-smi invocations with ${clients.length} clients in 1.5 s: ${calls}`);
  assert.ok(calls <= 2, `expected at most one poll per interval, saw ${calls}`);

  for (const c of clients) c.close();
});
