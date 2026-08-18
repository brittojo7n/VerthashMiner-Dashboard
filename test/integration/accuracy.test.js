"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { startServer, sseClient, request, delay, ROOT } = require("../helpers/harness");
const { reduceLog } = require("../helpers/oracle");
const { SESSION_LINES, SESSION_EXPECTED, SMI_OUTPUT } = require("../helpers/fixtures");

const importUi = name => import(pathToFileURL(path.join(ROOT, "public", "js", name)).href);

/** Console lines the dashboard is expected to display (protocol frames excluded). */
const VISIBLE_LINES = SESSION_LINES.filter(
  line => !line.includes('"id":') && !line.includes('"method":')
);

const LAST_LINE = SESSION_LINES.at(-1);

/**
 * End-to-end accuracy: a real child process emits the canonical console log,
 * the supervisor parses it, the HTTP/SSE layer ships it, and the browser
 * projection turns it into strings — which are then compared against an
 * independent reduction of the very same log lines.
 */
test("dashboard values equal the miner console, end to end", async t => {
  const app = await startServer({
    smi: (_bin, _args, _opts, cb) => cb(null, SMI_OUTPUT)
  });
  t.after(() => app.close());

  const client = sseClient(app.origin);
  await client.ready;
  await client.waitFor(() => true);

  await app.minerManager.start();

  const final = await client.waitFor(
    s => s.miner.logs.some(l => l.text === LAST_LINE.trim()),
    15000
  );

  const truth = reduceLog(SESSION_LINES);
  const { presentSnapshot, presentGpu } = await importUi("present.js");
  const view = presentSnapshot(final);

  // --- numbers -------------------------------------------------------------
  assert.equal(final.mining.accepted, truth.accepted);
  assert.equal(final.mining.submitted, truth.submitted);
  assert.equal(final.mining.rejected, truth.rejected);
  assert.equal(final.mining.difficulty, truth.difficulty);
  assert.ok(Math.abs(final.mining.hashrateKHs - truth.hashrateKHs) < 1e-9);

  // --- rendered strings ----------------------------------------------------
  assert.equal(view.hashrate, SESSION_EXPECTED.hashrateKHs.toFixed(2));
  assert.equal(view.accepted, "2 / 3");
  assert.equal(view.ratio, "66.7%");
  assert.equal(view.rejected, "1");
  assert.equal(view.difficulty, "0.125");
  assert.equal(view.status, "MINING");
  assert.equal(view.wallet, "vtc1qwddxt3rmwx00ev9yg4qcwpxnguw5zm7mwej2xk");

  // --- GPU attribution -----------------------------------------------------
  const gpus = final.gpu;
  assert.equal(gpus.length, 2);
  assert.equal(gpus[0].pciBusId, "01:00:0");
  assert.equal(gpus[0].hashrate, SESSION_EXPECTED.perDevice.cu_0);
  assert.equal(gpus[1].hashrate, SESSION_EXPECTED.perDevice.cu_1);
  assert.equal(presentGpu(gpus[0]).hashrate, "211.02");
  assert.ok(
    Math.abs(gpus[0].hashrate + gpus[1].hashrate - final.mining.hashrateKHs) < 1e-9,
    "per-GPU cards must add up to the headline hashrate"
  );

  client.close();
});

test("every console line is delivered to the UI, in order and exactly once", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const client = sseClient(app.origin);
  await client.ready;
  await client.waitFor(() => true);

  await app.minerManager.start();
  await client.waitFor(s => s.miner.logs.some(l => l.text === LAST_LINE.trim()), 15000);

  // Rebuild the console exactly the way the browser does: append every entry
  // whose id is newer than the last one rendered.
  const rendered = [];
  let maxId = 0;
  for (const snapshot of client.snapshots) {
    for (const entry of snapshot.miner.logs) {
      if (entry.id <= maxId) continue;
      rendered.push(entry);
      maxId = entry.id;
    }
  }

  const ids = rendered.map(e => e.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "ids arrive in order");
  assert.equal(new Set(ids).size, ids.length, "no duplicates");

  const texts = rendered.map(e => e.text);
  const expected = VISIBLE_LINES.map(l => l.trim());
  const startedAt = texts.indexOf(expected[0]);
  assert.ok(startedAt !== -1, "first miner line reached the UI");

  const minerLines = texts.filter(t => expected.includes(t));
  assert.deepEqual(minerLines, expected, "console mirrors the miner, line for line");

  // The rejected share must be explained, not just counted.
  assert.ok(texts.some(t => /Share Rejected: Low difficulty share/.test(t)));

  client.close();
});

test("protocol-dump frames never reach the console but still drive the metrics", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const client = sseClient(app.origin);
  await client.ready;
  await client.waitFor(() => true);
  await app.minerManager.start();

  const final = await client.waitFor(s => s.mining.difficulty === 0.125, 15000);
  const allText = client.snapshots.flatMap(s => s.miner.logs.map(l => l.text)).join("\n");

  assert.ok(!allText.includes('"method":"mining.submit"'), "no raw JSON in the console");
  assert.ok(!allText.includes('"result":true'), "no raw JSON in the console");
  assert.equal(final.mining.difficulty, 0.125, "difficulty still tracked");

  client.close();
});

test("/api/status and the SSE stream agree on every field", async t => {
  const app = await startServer({ smi: (_b, _a, _o, cb) => cb(null, SMI_OUTPUT) });
  t.after(() => app.close());

  const client = sseClient(app.origin);
  await client.ready;
  await client.waitFor(() => true);
  await app.minerManager.start();

  // Wait for the session to finish replaying so both views describe the same
  // instant; the mock miner then idles.
  await client.waitFor(s => s.miner.logs.some(l => l.text === LAST_LINE.trim()), 15000);
  await delay(120);

  const polled = (await request(app.origin, "/api/status")).json();
  const streamed = client.snapshots.at(-1);

  for (const key of ["accepted", "submitted", "rejected", "difficulty", "status"]) {
    assert.equal(polled.mining[key], streamed.mining[key], `mining.${key}`);
  }
  assert.equal(polled.miner.wallet, streamed.miner.wallet);
  assert.equal(polled.host.hostname, streamed.host.hostname);
  assert.ok(polled.miner.logs.length > 0, "the polling fallback carries a full log replay");

  client.close();
});

test("a mid-session client receives a complete, consistent view", async t => {
  const app = await startServer();
  t.after(() => app.close());

  const first = sseClient(app.origin);
  await first.ready;
  await first.waitFor(() => true);
  await app.minerManager.start();
  await first.waitFor(s => s.mining.accepted >= 1, 15000);

  const late = sseClient(app.origin);
  await late.ready;
  const initial = await late.waitFor(() => true);

  assert.ok(initial.miner.logs.length > 0, "late joiner gets a replay, not an empty console");
  assert.equal(initial.logCount, initial.miner.logs.length);
  assert.equal(initial.mining.accepted, app.state.mining.accepted);
  assert.equal(initial.mining.hashrateKHs, app.state.mining.hashrateKHs);

  first.close();
  late.close();
});

test("console history is capped at MAX_LOGS on both sides", async t => {
  const app = await startServer({ env: { MAX_LOGS: "15" } });
  t.after(() => app.close());

  const client = sseClient(app.origin);
  await client.ready;
  await client.waitFor(() => true);
  await app.minerManager.start();
  await client.waitFor(s => s.logSeq > 20, 15000);

  const latest = client.snapshots.at(-1);
  assert.equal(latest.logCapacity, 15);
  assert.ok(latest.logCount <= 15, `logCount=${latest.logCount}`);
  assert.equal(app.state.miner.logs.toJSON().length, 15);

  client.close();
});
