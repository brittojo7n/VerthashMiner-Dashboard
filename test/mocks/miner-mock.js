#!/usr/bin/env node
"use strict";
/*
 * VerthashMiner emulator for testing the dashboard.
 *
 * Reproduces the *exact* stdout/stderr contract documented in the dashboard's
 * parser (see src/parser.js, src/devices.js and README "Miner output"):
 *
 *  - All human logging goes to STDERR as:
 *      [YYYY-MM-DD HH:MM:SS] LEVEL  message
 *    with LEVEL padded to five characters ("ERROR ", "WARN  ", "INFO  ", "DEBUG ").
 *  - `--device-list` prints the CUDA/OpenCL device tables to STDOUT.
 *  - Per-device stats:   cu_device(N):[ err:K,] temp:NC, power:NW, fan:N%, hashrate: N.NN kH/s
 *  - Share results:      accepted: A/B (P%), total hashrate: N.NN kH/s | (pending...)
 *  - Difficulty:         Stratum difficulty set to N
 *  - Worker banner:      Configured N(CL) and M(CUDA) workers
 *  - Thread banner:      N miner threads started
 *  - --protocol-dump JSON frames on STDOUT.
 *
 * Knobs (environment):
 *   MOCK_MODE        healthy | pooldown | rejects | memerr | crash | flood | hang | quiet
 *   MOCK_GPUS        number of CUDA workers (default 2)
 *   MOCK_RATE_MS     ms between per-device stat bursts (default 1000)
 *   MOCK_SHARE_EVERY ms between share lines (default 4000)
 *   MOCK_DURATION_MS stop mining after this long (0 = forever, default 0)
 *   MOCK_EXIT_CODE   exit code when duration elapses (default 0)
 *   MOCK_IGNORE_SIGINT  if "1", ignore SIGINT (tests the force-kill watchdog)
 */
const os = require("node:os");

const MODE = process.env.MOCK_MODE || "healthy";
const GPUS = Math.max(1, Number(process.env.MOCK_GPUS) || 2);
const RATE_MS = Math.max(50, Number(process.env.MOCK_RATE_MS) || 1000);
const SHARE_EVERY = Math.max(100, Number(process.env.MOCK_SHARE_EVERY) || 4000);
const DURATION_MS = Number(process.env.MOCK_DURATION_MS) || 0;
const EXIT_CODE = Number(process.env.MOCK_EXIT_CODE) || 0;
const PENDING_RATIO = Number(process.env.MOCK_PENDING_RATIO) || 0; // fraction of share lines printed as (pending...)

const NAMES = ["NVIDIA GeForce RTX 3060", "NVIDIA GeForce GTX 1660 SUPER", "NVIDIA GeForce RTX 3070", "NVIDIA GeForce GTX 1080 Ti"];
const PCIS = ["01:00:0", "06:00:0", "05:00:0", "09:00:0"];
const FROZEN = process.env.MOCK_FROZEN_TIME === "1";

function stamp(date = new Date()) {
  if (FROZEN) date = new Date(1755710000000);
  const p = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}
function log(level, msg) {
  const tag = level.padEnd(5, " ");
  process.stderr.write(`[${stamp()}] ${tag} ${msg}\n`);
}
const jout = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (process.argv.includes("--device-list")) {
  process.stdout.write("Listing available devices\n\n");
  process.stdout.write("CUDA devices:\n");
  for (let i = 0; i < GPUS; i++) process.stdout.write(`\tIndex: ${i}. Name: ${NAMES[i % NAMES.length]} pcieId: ${PCIS[i % PCIS.length]}\n`);
  process.stdout.write("\nOpenCL devices:\n");
  process.stdout.write("\tIndex: 0. Name: Intel(R) UHD Graphics 630 pcieId: 00:02:0\n");
  process.exit(0);
}

const SELECT = (process.env.MOCK_DEVICE_SUBSET || "")
  .split(",").map(s => Number(s)).filter(Number.isInteger);

let running = true;
let accepted = 0, submitted = 0;
const rates = Array.from({ length: GPUS }, (_, i) => 1.4 + 0.6 * ((i * 7 + 3) % 5) / 5);
let tick = 0;
let poolDownAt = 0;

function statBurst() {
  if (!running) return;
  tick++;
  for (let i = 0; i < GPUS; i++) {
    const slot = i;
    const wobble = Math.sin((tick + i * 3) / 3) * 0.09;
    const hr = Math.max(0.01, rates[i] + wobble);
    const temp = 61 + ((i * 5 + tick) % 9);
    const power = 95 + ((i * 13 + tick * 2) % 40);
    const fan = 50 + ((tick + i) % 25);
    let extra = "";
    if (MODE === "memerr" && i === 0 && tick % 4 === 0) extra += ` err:${1 + (tick % 3)}, `;
    log("INFO", `cu_device(${slot}):[${extra} temp:${temp}C, power:${power}W, fan:${fan}%, hashrate: ${hr.toFixed(2)} kH/s`);
  }
}

function shareLine() {
  if (!running) return;
  if (poolDown) return; // a dead stratum socket accepts nothing
  submitted++;
  const rejectedNow = MODE === "rejects" && submitted % 5 === 0;
  if (!rejectedNow) accepted++;
  if (rejectedNow) jout({ id: 9 + submitted, jsonrpc: "2.0", result: false, error: [23, "Low difficulty share", null] });
  const pct = submitted ? Math.round((accepted / submitted) * 100) : 100;
  const total = rates.reduce((a, b) => a + b, 0);
  const pending = Math.random() < PENDING_RATIO;
  log("INFO", `accepted: ${accepted}/${submitted} (${pct}%), total hashrate: ${pending ? "(pending...)" : total.toFixed(2) + " kH/s"}`);
}

function startup() {
  log("INFO", `VerthashMiner-mock v1.0.1 starting on ${os.hostname()} (mode=${MODE}, gpus=${GPUS})`);
  log("INFO", "Built with CUDA 12.0, Verthash v1.0");
  log("INFO", "Loading verthash data file: verthash.dat");
  log("INFO", "Verthash data loaded and verified succesfully");
  jout({ id: 1, method: "mining.subscribe", params: ["verthashminer-mock/1.0"] });
  jout({ id: 1, jsonrpc: "2.0", result: [["mining.notify", "ae6812eb4cd7735a302a870929573694"], "080000c0", 8] });
  log("INFO", `Configured 0(CL) and ${GPUS}(CUDA) workers`);
  log("INFO", `${GPUS} miner threads started`);
  log("INFO", "Pool: stratum+tcp://vtc.pool.example:9172 user VkcRz...(mock)");
  jout({ id: null, method: "mining.set_difficulty", params: [0.0244140625] });
  log("INFO", "Stratum difficulty set to 0.0244140625");
  log("INFO", "Stratum connection succeeded");
}

function shutdown(code) {
  running = false;
  clearInterval(statTimer);
  clearInterval(shareTimer);
  if (poolTimer) clearTimeout(poolTimer);
  if (keepalive) clearInterval(keepalive);
  log("INFO", "Shutting down workers...");
  process.exit(code);
}

startup();
if (MODE !== "silent") statBurst();

const statTimer = setInterval(statBurst, RATE_MS);
const shareTimer = setInterval(shareLine, SHARE_EVERY);

let poolTimer = null;
let poolDown = false;
if (MODE === "pooldown") {
  poolTimer = setTimeout(() => {
    poolDown = true;
    log("ERROR", "stratum_recv_line failed");
    log("ERROR", "Stratum connection timed out");
    poolDownAt = Date.now();
    poolTimer = setTimeout(() => {
      poolDown = false;
      log("INFO", "Stratum connection succeeded");
      jout({ id: null, method: "mining.set_difficulty", params: [0.048828125] });
      log("INFO", "Stratum difficulty set to 0.048828125");
    }, 6000);
  }, 5000);
}

if (MODE === "flood") {
  let n = 0;
  setInterval(() => { for (let i = 0; i < 30; i++) log("DEBUG", `flood noise line ${++n} ${"x".repeat(40)}`); }, 1000);
}

if (MODE === "crash") {
  setTimeout(() => {
    log("ERROR", "CUDA error in hashrate loop: out of memory");
    process.exit(1);
  }, 5000);
}

let keepalive = null;
if (MODE === "quiet" || MODE === "silent") {
  // startup only; no periodic output (tests the idle path).
  // keep an inert handle so the emulated miner stays alive like the real one.
  clearInterval(statTimer);
  clearInterval(shareTimer);
  keepalive = setInterval(() => {}, 1 << 30);
}
if (MODE === "visual") {
  // deterministic one-shot dataset for pixel-diff tests: startup + a single
  // stat burst, then silence.
  clearInterval(statTimer);
  clearInterval(shareTimer);
  keepalive = setInterval(() => {}, 1 << 30);
}

if (DURATION_MS > 0) setTimeout(() => shutdown(EXIT_CODE), DURATION_MS);

if (process.env.MOCK_IGNORE_SIGINT === "1") {
  process.on("SIGINT", () => log("WARN", "SIGINT received but ignored (hang mode)"));
  process.on("SIGTERM", () => log("WARN", "SIGTERM received but ignored (hang mode)"));
} else {
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}
