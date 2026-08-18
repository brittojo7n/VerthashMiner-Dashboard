#!/usr/bin/env node
"use strict";

/**
 * Stand-in for VerthashMiner.exe.
 *
 * Reproduces the parts of the real binary the dashboard depends on:
 *  - `--device-list` prints the CUDA/OpenCL enumeration on stdout and exits 0;
 *  - normal runs stream applog-formatted lines on **stderr** (as upstream does);
 *  - behaviour switches for every failure mode the supervisor must survive.
 *
 * Behaviour is chosen with MOCK_MINER_MODE:
 *   session   (default) replay the canonical corpus, then idle
 *   loop      replay the corpus forever (stress)
 *   crash     emit a few lines then exit(1)
 *   instant   exit(1) immediately
 *   hang      print nothing, ignore SIGINT/SIGTERM (force-kill path)
 *   probehang hang only during --device-list (probe watchdog)
 *   flood     emit MOCK_MINER_RATE lines per tick as fast as possible
 *   nonewline emit a huge partial line with no newline
 *   binary    emit invalid UTF-8 / control characters
 */

const fixtures = require("../helpers/fixtures");

const mode = process.env.MOCK_MINER_MODE || "session";
const intervalMs = Number(process.env.MOCK_MINER_INTERVAL_MS || 5);
const args = process.argv.slice(2);

function emit(line) {
  process.stderr.write(`${line}\n`);
}

if (args.includes("--device-list") || args.includes("-l")) {
  if (mode === "probehang") {
    setInterval(() => {}, 1 << 30);
  } else if (mode === "probefail") {
    process.exit(2);
  } else {
    process.stdout.write(`${fixtures.DEVICE_LIST_OUTPUT}\n`);
    process.exit(0);
  }
  return;
}

if (mode === "instant") process.exit(1);

if (mode === "hang") {
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1 << 30);
  return;
}

if (mode === "nonewline") {
  process.stderr.write("x".repeat(512 * 1024));
  setInterval(() => process.stderr.write("y".repeat(64 * 1024)), 50);
  return;
}

if (mode === "binary") {
  process.stderr.write(Buffer.from([0xc3, 0x28, 0xa0, 0xa1, 0x00, 0x0a]));
  emit(fixtures.SESSION_LINES[0]);
  setInterval(() => {}, 1 << 30);
  return;
}

if (mode === "flood") {
  const rate = Number(process.env.MOCK_MINER_RATE || 500);
  const total = Number(process.env.MOCK_MINER_TOTAL || 20000);
  const lines = fixtures.generateLines(total);
  let i = 0;
  const pump = () => {
    const end = Math.min(lines.length, i + rate);
    let block = "";
    for (; i < end; i++) block += `${lines[i]}\n`;
    process.stderr.write(block);
    if (i < lines.length) setImmediate(pump);
  };
  pump();
  setInterval(() => {}, 1 << 30);
  return;
}

const lines = fixtures.SESSION_LINES;
let index = 0;

const timer = setInterval(() => {
  if (index >= lines.length) {
    if (mode === "loop") {
      index = 0;
    } else if (mode === "crash") {
      clearInterval(timer);
      process.exit(1);
    } else {
      clearInterval(timer);
      setInterval(() => {}, 1 << 30);
    }
    return;
  }
  emit(lines[index++]);
}, intervalMs);

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
