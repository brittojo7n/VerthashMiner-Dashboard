"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createState } = require("../../src/state");
const { parseMinerLine, levelOf, classifyLine } = require("../../src/parser");
const { reduceLog } = require("../helpers/oracle");
const { feed, markRunning } = require("../helpers/harness");
const {
  SESSION_LINES,
  SESSION_EXPECTED,
  FALSE_POSITIVE_LINES,
  FATAL_LINES,
  MALFORMED_LINES,
  log,
  device,
  share
} = require("../helpers/fixtures");

function freshState() {
  return markRunning(createState("vtc1qtest", 50));
}

test("levelOf() reads the applog level at its fixed offset", () => {
  assert.equal(levelOf(log("INFO", "hello")), "INFO");
  assert.equal(levelOf(log("WARN", "hello")), "WARN");
  assert.equal(levelOf(log("ERROR", "hello")), "ERROR");
  assert.equal(levelOf(log("DEBUG", "hello")), "DEBUG");
  assert.equal(levelOf("plain line"), null);
  assert.equal(levelOf("[2026-08-18 20:00:00] BOGUS message"), null);
  assert.equal(levelOf(""), null);
});

test("classifyLine() never marks INFO/DEBUG output as fatal", () => {
  for (const line of FALSE_POSITIVE_LINES) {
    const verdict = classifyLine(line, line.toLowerCase(), levelOf(line));
    assert.equal(verdict.isFatal, false, `must not be fatal: ${line}`);
  }
});

test("full session: every metric matches the independent oracle", () => {
  const state = freshState();
  feed(SESSION_LINES, state);
  const expected = reduceLog(SESSION_LINES);

  assert.equal(state.mining.accepted, expected.accepted);
  assert.equal(state.mining.submitted, expected.submitted);
  assert.equal(state.mining.rejected, expected.rejected);
  assert.equal(state.mining.difficulty, expected.difficulty);
  assert.equal(state.mining.status, expected.status);
  assert.equal(state.mining.expectedWorkers, expected.workers);
  assert.ok(Math.abs(state.mining.hashrateKHs - expected.hashrateKHs) < 1e-9);

  // ...and against the hand-derived table, so a bug in the oracle cannot hide.
  assert.equal(state.mining.accepted, SESSION_EXPECTED.accepted);
  assert.equal(state.mining.submitted, SESSION_EXPECTED.submitted);
  assert.equal(state.mining.rejected, SESSION_EXPECTED.rejected);
  assert.equal(state.mining.difficulty, SESSION_EXPECTED.difficulty);
  assert.equal(state.mining.status, SESSION_EXPECTED.status);
  assert.deepEqual({ ...state.mining.gpuHashrates }, SESSION_EXPECTED.perDevice);
});

test("prefix-by-prefix replay stays in lockstep with the oracle", () => {
  for (let i = 1; i <= SESSION_LINES.length; i++) {
    const slice = SESSION_LINES.slice(0, i);
    const state = freshState();
    feed(slice, state);
    const expected = reduceLog(slice);

    assert.equal(state.mining.accepted, expected.accepted, `accepted @${i}`);
    assert.equal(state.mining.submitted, expected.submitted, `submitted @${i}`);
    assert.equal(state.mining.rejected, expected.rejected, `rejected @${i}`);
    assert.equal(state.mining.difficulty, expected.difficulty, `difficulty @${i}`);
    if (expected.hashrateKHs === null) {
      assert.equal(state.mining.hashrateKHs, null, `hashrate @${i}`);
    } else {
      assert.ok(
        Math.abs(state.mining.hashrateKHs - expected.hashrateKHs) < 1e-9,
        `hashrate @${i}: ${state.mining.hashrateKHs} != ${expected.hashrateKHs}`
      );
    }
  }
});

test("total hashrate is the exact sum of the per-device lines (no drift)", () => {
  const state = freshState();
  parseMinerLine(log("INFO", "Configured 0(CL) and 2(CUDA) workers"), state);

  let expected = 0;
  for (let i = 0; i < 500; i++) {
    const a = 210.11 + (i % 7) * 0.13;
    const b = 209.67 + (i % 5) * 0.17;
    parseMinerLine(log("INFO", device("cu", 0, a)), state);
    parseMinerLine(log("INFO", device("cu", 1, b)), state);
    expected = Number(a.toFixed(2)) + Number(b.toFixed(2));
  }
  assert.ok(Math.abs(state.mining.hashrateKHs - expected) < 1e-9);
});

test("partial device coverage never reports a partial rig total", () => {
  const state = freshState();
  parseMinerLine(log("INFO", "Configured 0(CL) and 2(CUDA) workers"), state);
  parseMinerLine(log("INFO", device("cu", 0, 210.11)), state);
  assert.equal(state.mining.hashrateKHs, null, "one of two devices reported");

  parseMinerLine(log("INFO", device("cu", 1, 209.67)), state);
  assert.ok(Math.abs(state.mining.hashrateKHs - 419.78) < 1e-9);
});

test("worker count is inferred from the thread banner when the CL/CUDA line is missing", () => {
  const state = freshState();
  parseMinerLine(log("INFO", "2 miner threads started, using Verthash algorithm."), state);
  assert.equal(state.mining.expectedWorkers, 2);
});

test("device subsets map worker slots back to device indices", () => {
  const state = freshState();
  state.mining.workerMap = { cu: [1, 3], cl: null };
  parseMinerLine(log("INFO", device("cu", 0, 100)), state);
  parseMinerLine(log("INFO", device("cu", 1, 200)), state);
  assert.deepEqual({ ...state.mining.gpuHashrates }, { cu_1: 100, cu_3: 200 });
});

test("pool-down messages report DISCONNECTED, hard faults report CRASHED", () => {
  for (const [line, expected] of FATAL_LINES) {
    const state = freshState();
    parseMinerLine(line, state);
    assert.equal(state.mining.status, expected, line);
    assert.equal(state.miner.lastError, line);
  }
});

test("difficulty prefers the protocol dump and accepts scientific notation", () => {
  const state = freshState();
  parseMinerLine(
    log("DEBUG", '< {"id":null,"method":"mining.set_difficulty","params":[0.0625]}'),
    state
  );
  assert.equal(state.mining.difficulty, 0.0625);

  parseMinerLine(log("INFO", "Stratum difficulty set to 1e-05"), state);
  assert.equal(state.mining.difficulty, 1e-5);

  parseMinerLine(log("INFO", "Stratum difficulty set to 256"), state);
  assert.equal(state.mining.difficulty, 256);
});

test("rejected shares are counted and explained exactly once", () => {
  const state = freshState();
  const entries = [];
  const push = (text, type) => entries.push({ text, type });

  parseMinerLine(log("DEBUG", '< {"id":5,"result":false,"error":[23,"Low difficulty share",null]}'), state, push);
  parseMinerLine(log("INFO", share(1, 2, 419.78)), state, push);

  assert.equal(state.mining.rejected, 1);
  const rejectLines = entries.filter(e => e.text.includes("Rejected"));
  assert.equal(rejectLines.length, 1, "no duplicate failsafe line");
  assert.match(rejectLines[0].text, /Low difficulty share/);
});

test("a reject with no protocol dump still produces a failsafe log line", () => {
  const state = freshState();
  const entries = [];
  parseMinerLine(log("INFO", share(4, 6, 419.78)), state, (text, type) => entries.push({ text, type }));

  assert.equal(state.mining.rejected, 2);
  assert.ok(entries.some(e => /2 Share\(s\) Rejected \(Failsafe\)/.test(e.text)));
});

test("JSON protocol frames stay out of the console but still update state", () => {
  const state = freshState();
  const entries = [];
  parseMinerLine(
    log("DEBUG", '< {"id":null,"method":"mining.set_difficulty","params":[0.5]}'),
    state,
    (text, type) => entries.push({ text, type })
  );
  assert.equal(entries.length, 0);
  assert.equal(state.mining.difficulty, 0.5);
  assert.equal(state.dirty, true, "state must be marked dirty so the UI is told");
});

test("every state mutation marks the snapshot dirty", () => {
  const cases = [
    log("INFO", device("cu", 0, 210.11)),
    log("INFO", share(1, 1, 210.11)),
    log("INFO", "Stratum difficulty set to 0.25"),
    log("ERROR", "Stratum connection timed out")
  ];
  for (const line of cases) {
    const state = freshState();
    state.dirty = false;
    parseMinerLine(line, state);
    assert.equal(state.dirty, true, line);
  }
});

test("ANSI escapes are stripped before classification", () => {
  const state = freshState();
  parseMinerLine(`\u001b[31m${log("ERROR", "Stratum connection timed out")}\u001b[0m`, state);
  assert.equal(state.mining.status, "DISCONNECTED");
});

test("malformed input never throws and never corrupts state", () => {
  const state = freshState();
  for (const line of MALFORMED_LINES) {
    assert.doesNotThrow(() => parseMinerLine(line, state), `threw on: ${line.slice(0, 40)}`);
  }
  assert.ok(state.mining.accepted >= 0);
  assert.ok(state.mining.submitted >= 0);
  assert.ok(state.mining.rejected >= 0);
  assert.ok(state.mining.difficulty === null || Number.isFinite(state.mining.difficulty));
  assert.ok(state.mining.hashrateKHs === null || Number.isFinite(state.mining.hashrateKHs));
});

test("stopped miners are never flipped back to a running status", () => {
  const state = createState("w", 20);
  state.miner.running = false;
  state.mining.status = "STOPPED";
  parseMinerLine(log("INFO", device("cu", 0, 210.11)), state);
  parseMinerLine(log("INFO", share(1, 1, 210.11)), state);
  assert.equal(state.mining.status, "STOPPED");
});

test("memory-error counters are warnings, not failures", () => {
  const state = freshState();
  const entries = [];
  parseMinerLine(
    log("INFO", device("cu", 0, 210.11, { err: 4, temp: 63 })),
    state,
    (text, type) => entries.push({ text, type })
  );
  assert.equal(entries[0].type, "warn");
  assert.equal(state.mining.status, "MINING");
  assert.equal(state.miner.lastError, "");
});
