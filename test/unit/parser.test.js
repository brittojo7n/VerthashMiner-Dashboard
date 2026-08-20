"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseMinerLine, classifyLine, levelOf, sumDeviceHashrates } = require("../../src/parser");
const { STATUS } = require("../../src/constants");
const { createState } = require("../../src/state");

const ts = () => `[2026-08-20 12:00:00]`;
function state() {
  const s = createState("", 50);
  s.miner.running = true;
  s.mining.status = STATUS.STARTING;
  return s;
}
const line = (level, msg) => `${ts()} ${level.padEnd(5, " ")} ${msg}`;

test("levelOf: fixed-offset level extraction", () => {
  assert.equal(levelOf(line("INFO", "hello")), "INFO");
  assert.equal(levelOf(line("ERROR", "boom")), "ERROR");
  assert.equal(levelOf(line("WARN", "careful")), "WARN");
  assert.equal(levelOf(line("DEBUG", "noise")), "DEBUG");
  assert.equal(levelOf("[2026-08-20 12:00:00] TRACE  nope"), null, "unknown level");
  assert.equal(levelOf("short line"), null);
  assert.equal(levelOf(""), null);
  // no leading bracket / wrong offsets
  assert.equal(levelOf("x026-08-20 12:00:00] INFO  fake"), null);
});

test("parser: per-device hashrate lines populate gpuHashrates and rig total only when all workers reported", () => {
  const s = state();
  s.mining.expectedWorkers = 2;
  parseMinerLine(line("INFO", "cu_device(0):[ temp:64C, power:118W, fan:55%, hashrate: 1.50 kH/s"), s);
  assert.equal(s.mining.hashrateKHs, null, "total must stay hidden until every worker reported");
  assert.equal(s.mining.gpuHashrates.cu_0, 1.5);
  parseMinerLine(line("INFO", "cu_device(1):[ temp:71C, power:95W, fan:60%, hashrate: 2.00 kH/s"), s);
  assert.equal(s.mining.gpuHashrates.cu_1, 2.0);
  assert.equal(s.mining.hashrateKHs, 3.5, "total = sum of per-device rates, not an average");
  assert.equal(s.mining.status, STATUS.MINING);
});

test("parser: worker slot is remapped through --cu-devices selection", () => {
  const s = state();
  s.mining.workerMap = { cu: [1, 3], cl: null };
  parseMinerLine(line("INFO", "cu_device(0):[ hashrate: 1.00 kH/s"), s);
  parseMinerLine(line("INFO", "cu_device(1):[ hashrate: 2.00 kH/s"), s);
  assert.equal(s.mining.gpuHashrates.cu_1, 1, "worker 0 -> device 1");
  assert.equal(s.mining.gpuHashrates.cu_3, 2, "worker 1 -> device 3");
});

test("parser: accepted share line updates counters, ratio inputs and lastAcceptedAt", () => {
  const s = state();
  parseMinerLine(line("INFO", "accepted: 7/8 (87%), total hashrate: 4.25 kH/s"), s);
  assert.equal(s.mining.accepted, 7);
  assert.equal(s.mining.submitted, 8);
  assert.equal(s.mining.rejected, 1, "rejected = submitted - accepted");
  assert.ok(s.mining.lastAcceptedAt > 0);
  assert.equal(s.mining.hashrateKHs, 4.25, "total hashrate from share line is authoritative");
});

test("parser: (pending...) share line keeps last known total hashrate", () => {
  const s = state();
  parseMinerLine(line("INFO", "accepted: 1/1 (100%), total hashrate: 4.25 kH/s"), s);
  parseMinerLine(line("INFO", "accepted: 2/2 (100%), total hashrate: (pending...)"), s);
  assert.equal(s.mining.hashrateKHs, 4.25);
});

test("parser: reject JSON frame is counted, surfaced as a console error, and not double counted by the failsafe", () => {
  const s = state();
  const logs = [];
  const push = (text, type) => logs.push({ text, type });
  parseMinerLine('{"id":9,"jsonrpc":"2.0","result":false,"error":[23,"Low difficulty share",null]}', s, push);
  assert.equal(s.mining.jsonRejects, 1);
  assert.deepEqual(logs.map(l => l.text), ["[Stratum] Share Rejected: Low difficulty share"]);
  assert.equal(logs[0].type, "error");
  // the matching accepted: A/B line arrives afterwards -> failsafe must NOT duplicate the reject
  parseMinerLine(line("INFO", "accepted: 3/4 (75%), total hashrate: 4.0 kH/s"), s, push);
  assert.equal(s.mining.rejected, 1);
  assert.equal(logs.filter(l => l.text.includes("Failsafe")).length, 0, "no failsafe duplicate when jsonRejects already explains it");
});

test("parser: unexplained rejects trigger the failsafe console line", () => {
  const s = state();
  const logs = [];
  parseMinerLine(line("INFO", "accepted: 5/8 (62%), total hashrate: 4.0 kH/s"), s, (t, ty) => logs.push(t));
  assert.equal(s.mining.rejected, 3);
  assert.ok(logs.some(t => t.includes("3 Share(s) Rejected (Failsafe)")));
});

test("parser: inline err:N memory counter is a WARN, not a failure", () => {
  const s = state();
  const out = classifyLine(line("INFO", "cu_device(0):[ err:2, temp:64C, hashrate: 1.5 kH/s"), "cu_device(0):[ err:2,", null);
  assert.equal(out.type, "warn");
  assert.equal(out.isFatal, false);
  parseMinerLine(line("INFO", "cu_device(0):[ err:2, temp:64C, hashrate: 1.5 kH/s"), s);
  assert.equal(s.mining.status, STATUS.MINING, "err:N on an otherwise healthy line must not clear MINING");
});

test("parser: DEBUG stratum noise is never fatal", () => {
  const s = state();
  parseMinerLine(line("DEBUG", "Failed to get Stratum session id"), s);
  assert.notEqual(s.mining.status, STATUS.CRASHED);
  assert.equal(s.miner.lastError, "");
});

test("parser: only ERROR-level lines can flip run status", () => {
  const s = state();
  s.mining.status = STATUS.MINING;
  parseMinerLine(line("INFO", "cuda error out of memory"), s);
  assert.equal(s.mining.status, STATUS.MINING, "INFO line containing fatal keywords stays MINING");
  parseMinerLine(line("ERROR", "cuda error in hashrate loop"), s);
  assert.equal(s.mining.status, STATUS.CRASHED);
  assert.equal(s.miner.lastError, line("ERROR", "cuda error in hashrate loop"));
});

test("parser: stratum pool failures without fatal keywords map to DISCONNECTED", () => {
  for (const msg of [
    "Stratum connection timed out",
    "stratum_recv_line failed",
    "Stratum authentication failed",
    "stratum_subscribe failed",
    "Stratum connection interrupted",
    "json_rpc_call failed"
  ]) {
    const s = state();
    s.mining.status = STATUS.MINING;
    parseMinerLine(line("ERROR", msg), s);
    assert.equal(s.mining.status, STATUS.DISCONNECTED, msg);
  }
});

test("parser: while DISCONNECTED, hashrate lines do not mask the outage", () => {
  const s = state();
  s.mining.status = STATUS.DISCONNECTED;
  s.miner.lastError = line("ERROR", "Stratum connection timed out");
  parseMinerLine(line("INFO", "cu_device(0):[ hashrate: 1.20 kH/s"), s);
  assert.equal(s.mining.status, STATUS.DISCONNECTED, "threads keep hashing on the last job; pool is still gone");
  assert.equal(s.miner.lastError, line("ERROR", "Stratum connection timed out"), "error surface retained");
  assert.equal(s.mining.gpuHashrates.cu_0, 1.2, "telemetry itself still tracked");
});

test("parser: recovery paths clear DISCONNECTED (share accept, stratum reconnect)", () => {
  const a = state();
  a.mining.status = STATUS.DISCONNECTED;
  a.miner.lastError = line("ERROR", "Stratum connection timed out");
  parseMinerLine(line("INFO", "Stratum connection succeeded"), a);
  assert.equal(a.mining.status, STATUS.CONNECTED, "reconnect line restores a live status");

  const b = state();
  b.mining.status = STATUS.DISCONNECTED;
  b.miner.lastError = line("ERROR", "stratum_recv_line failed");
  parseMinerLine(line("INFO", "accepted: 9/9 (100%), total hashrate: 3.9 kH/s"), b);
  assert.equal(b.mining.status, STATUS.MINING, "accepted share proves the pool is back");
  assert.equal(b.miner.lastError, "");
});

test("parser: STOPPING/STOPPED shield status changes from log noise", () => {
  const s = state();
  s.mining.status = STATUS.STOPPING;
  parseMinerLine(line("ERROR", "cuda error"), s);
  assert.equal(s.mining.status, STATUS.STOPPING);
  assert.equal(s.miner.lastError, "", "no error surface during deliberate stop");
});

test("parser: difficulty lines (plain, colon, exponential) update state exactly once", () => {
  const s = state();
  parseMinerLine(line("INFO", "Stratum difficulty set to 0.0244140625"), s);
  assert.equal(s.mining.difficulty, 0.0244140625);
  parseMinerLine(line("DEBUG", "difficulty is: 1e-05"), s);
  assert.equal(s.mining.difficulty, 1e-5, "exponential notation parses");
  const before = s.dirty;
  parseMinerLine(line("DEBUG", "difficulty is: 1e-05"), s);
  assert.equal(s.mining.difficulty, 1e-5);
});

test("parser: mining.set_difficulty JSON frame updates difficulty and is not echoed to console", () => {
  const s = state();
  const logs = [];
  parseMinerLine('{"id":null,"method":"mining.set_difficulty","params":[0.048828125]}', s, (t, ty) => logs.push(t));
  assert.equal(s.mining.difficulty, 0.048828125);
  assert.equal(logs.length, 0, "JSON protocol frames are consumed, not echoed");
});

test("parser: worker banner and thread banner set expectedWorkers", () => {
  const a = state();
  parseMinerLine(line("INFO", "Configured 2(CL) and 3(CUDA) workers"), a);
  assert.equal(a.mining.expectedWorkers, 5);
  const b = state();
  parseMinerLine(line("INFO", "4 miner threads started"), b);
  assert.equal(b.mining.expectedWorkers, 4);
});

test("parser: no worker banner -> total published on the device's second report (warmup fallback)", () => {
  const s = state();
  parseMinerLine(line("INFO", "cu_device(0):[ hashrate: 1.10 kH/s"), s);
  assert.equal(s.mining.hashrateKHs, null, "first report of a device never publishes the rig total");
  parseMinerLine(line("INFO", "cu_device(0):[ hashrate: 1.30 kH/s"), s);
  assert.equal(s.mining.hashrateKHs, 1.3, "second report closes the warmup window");
});

test("parser: ANSI escapes are stripped before parsing", () => {
  const s = state();
  const raw = `\u001b[32m${line("INFO", "cu_device(0):[ hashrate: 1.25 kH/s")}\u001b[0m`;
  parseMinerLine(raw, s);
  assert.equal(s.mining.gpuHashrates.cu_0, 1.25);
});

test("parser: classification buckets for the console colours", () => {
  assert.equal(classifyLine(line("ERROR", "x"), "", "ERROR").type, "error");
  assert.equal(classifyLine(line("WARN", "x"), "", "WARN").type, "warn");
  assert.equal(classifyLine(line("INFO", "Loaded succesfully"), "loaded succes", null).type, "success");
  assert.equal(classifyLine(line("INFO", "accepted: 1/1 (100%)"), "accepted:", null).type, "success");
  assert.equal(classifyLine(line("INFO", "Stratum connection succeeded"), "stratum", null).type, "accent");
  assert.equal(classifyLine(line("INFO", "hello"), "hello", "INFO").type, "info");
});

test("parser: CONNECTED/WAITING soft status transitions", () => {
  const s = state();
  parseMinerLine(line("INFO", "Stratum connection succeeded"), s);
  assert.equal(s.mining.status, STATUS.CONNECTED);
  parseMinerLine(line("INFO", "Waiting for work"), s);
  assert.equal(s.mining.status, STATUS.WAITING);
});

test("parser: cl_device lines are tracked under the cl_ prefix", () => {
  const s = state();
  parseMinerLine(line("INFO", "cl_device(2):[ hashrate: 0.80 kH/s"), s);
  assert.equal(s.mining.gpuHashrates.cl_2, 0.8);
  assert.equal(sumDeviceHashrates(s.mining.gpuHashrates), 0.8);
});

test("parser: non-finite hashrate garbage is ignored", () => {
  const s = state();
  parseMinerLine(line("INFO", "cu_device(0):[ hashrate: nan kH/s"), s);
  assert.equal(s.mining.gpuHashrates.cu_0, undefined);
});
