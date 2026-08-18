"use strict";

/**
 * Canonical VerthashMiner console corpus.
 *
 * Every format here was taken from the upstream sources
 * (CryptoGraphics/VerthashMiner @ main):
 *
 *   applog()                 src/vhCore/Util.cpp:88
 *     "[%d-%02d-%02d %02d:%02d:%02d] %-5s %s\n"   levels: ERROR WARN INFO DEBUG
 *   share result             src/main.cpp:740
 *     "accepted: %lu/%lu (%.2f%%), total hashrate: %s"   ("(pending...)" | "%.2f kH/s")
 *   per device hashrate      src/main.cpp:3177 / :2177
 *     "cu_device(%d):%s%s%s%s hashrate: %.02f kH/s"
 *     with " err:%u," " temp:%dC," " power:%dW," " fan:%d%%,"
 *   difficulty               src/vhCore/Util.cpp:1523
 *     "Stratum difficulty set to %g"
 *   protocol dump (-P)       src/vhCore/Util.cpp:1014 / :1137
 *     "> %s" / "< %s"
 *   device list (-l)         src/main.cpp:4744
 *     "\tIndex: %u. Name: %s. pcieId: %s"
 *   worker banner            src/main.cpp:5959
 *     "Configured %llu(CL) and %llu(CUDA) workers"
 */

const DEVICE_LIST_OUTPUT = [
  "OpenCL devices:",
  "\tIndex: 0. Name: NVIDIA GeForce RTX 3060",
  "\t          Platform index: 0",
  "\t          Platform name: NVIDIA Corporation",
  "\t          pcieId: 01:00:0",
  "",
  "CUDA devices:",
  "\tIndex: 0. Name: NVIDIA GeForce RTX 3060. pcieId: 01:00:0",
  "\tIndex: 1. Name: NVIDIA GeForce RTX 3070. pcieId: 08:00:0",
  ""
].join("\n");

const SMI_OUTPUT = [
  "NVIDIA GeForce RTX 3060, 63, 118.42, 99, 1830, 7300, 4021, 12288, P2, 00000000:01:00.0",
  "NVIDIA GeForce RTX 3070, 68, 179.05, 100, 1905, 7000, 5877, 8192, P2, 00000000:08:00.0"
].join("\n");

const ts = n => {
  const base = Date.UTC(2026, 7, 18, 20, 0, 0) + n * 1000;
  return new Date(base).toISOString().replace("T", " ").slice(0, 19);
};

/** applog-formatted line: level is padded to five characters. */
const log = (level, message, n = 0) => `[${ts(n)}] ${level.padEnd(5)} ${message}`;

const device = (kind, index, hashrate, opts = {}) => {
  const err = opts.err !== undefined ? ` err:${opts.err},` : "";
  const temp = opts.temp !== undefined ? ` temp:${opts.temp}C,` : "";
  const power = opts.power !== undefined ? ` power:${opts.power}W,` : "";
  const fan = opts.fan !== undefined ? ` fan:${opts.fan}%,` : "";
  return `${kind}_device(${index}):${err}${temp}${power}${fan} hashrate: ${hashrate.toFixed(2)} kH/s`;
};

const share = (accepted, submitted, total) => {
  const pct = ((100 * accepted) / submitted).toFixed(2);
  const rate = total === null ? "(pending...)" : `${total.toFixed(2)} kH/s`;
  return `accepted: ${accepted}/${submitted} (${pct}%), total hashrate: ${rate}`;
};

/**
 * A full, ordered mining session: boot -> stratum -> shares -> a rejected
 * share -> a pool drop -> recovery. Used by the accuracy tests as the single
 * source of truth for both the parser and the independent oracle.
 */
const SESSION_LINES = [
  log("INFO", "Loading verthash data file...", 0),
  log("INFO", "Verthash data file has been loaded succesfully!", 1),
  log("INFO", "Verifying verthash data file...", 2),
  log("INFO", "Verthash data file has been verified succesfully!", 3),
  log("DEBUG", "Failed to get Stratum session id", 4),
  log("INFO", "Miner has been successfully configured! (Errors: 0, Warnings: 0)", 5),
  log("INFO", "Configured 0(CL) and 2(CUDA) workers", 6),
  log("INFO", "Starting Stratum on stratum+tcp://verthash.sea.mine.zpool.ca:6144", 7),
  log("INFO", "2 miner threads started, using Verthash algorithm.", 8),
  log("DEBUG", '< {"id":null,"method":"mining.set_difficulty","params":[0.0625]}', 9),
  log("INFO", "Stratum difficulty set to 0.0625", 10),
  log("INFO", "cu_device(0): WorkSize has been set to: 131072", 11),
  log("INFO", device("cu", 0, 210.11, { err: 0, temp: 63, power: 118, fan: 52 }), 12),
  log("INFO", device("cu", 1, 209.67, { err: 0, temp: 68, power: 179, fan: 61 }), 13),
  log("DEBUG", '> {"id":4,"method":"mining.submit","params":["vtc1q","0001","00","5f2b","1a"]}', 14),
  log("DEBUG", '< {"id":4,"result":true,"error":null}', 15),
  log("INFO", share(1, 1, 419.78), 16),
  log("INFO", device("cu", 0, 210.34, { err: 0, temp: 64, power: 119, fan: 54 }), 17),
  log("INFO", device("cu", 1, 209.79, { err: 1, temp: 69, power: 180, fan: 63 }), 18),
  log("DEBUG", '< {"id":5,"result":false,"error":[23,"Low difficulty share",null]}', 19),
  log("INFO", share(1, 2, 420.13), 20),
  log("INFO", "Stratum difficulty set to 0.125", 21),
  log("ERROR", "Stratum connection timed out", 22),
  log("INFO", "Starting Stratum on stratum+tcp://verthash.sea.mine.zpool.ca:6144", 23),
  log("INFO", device("cu", 0, 211.02, { err: 0, temp: 64, power: 119, fan: 55 }), 24),
  log("INFO", device("cu", 1, 210.44, { err: 0, temp: 69, power: 181, fan: 63 }), 25),
  log("INFO", share(2, 3, 421.46), 26)
];

/** Expected values after the whole session, derived by hand from the corpus. */
const SESSION_EXPECTED = Object.freeze({
  accepted: 2,
  submitted: 3,
  rejected: 1,
  difficulty: 0.125,
  hashrateKHs: 421.46,
  status: "MINING",
  expectedWorkers: 2,
  perDevice: Object.freeze({ cu_0: 211.02, cu_1: 210.44 })
});

/** Lines that used to be misread as fatal crashes (regression corpus). */
const FALSE_POSITIVE_LINES = [
  log("DEBUG", "Failed to get Stratum session id", 0),
  log("DEBUG", "stale work detected, discarding", 1),
  log("INFO", "JSON decode failed(3): unexpected token", 2),
  log("INFO", "Miner has been successfully configured! (Errors: 0, Warnings: 0)", 3),
  log("WARN", "cu_device(0):ADL Overdrive is not supported!", 4),
  log("INFO", device("cu", 0, 210.11, { err: 3, temp: 63 }), 5)
];

/** Lines that must be treated as terminal, with their expected status. */
const FATAL_LINES = [
  [log("ERROR", "Stratum connection timed out", 0), "DISCONNECTED"],
  [log("ERROR", "Stratum connection interrupted", 1), "DISCONNECTED"],
  [log("ERROR", "Stratum connection failed: Connection refused", 2), "DISCONNECTED"],
  [log("ERROR", "stratum_recv_line timed out", 3), "DISCONNECTED"],
  [log("ERROR", "stratum_recv_line failed", 4), "DISCONNECTED"],
  [log("ERROR", "Stratum authentication failed", 5), "DISCONNECTED"],
  [log("ERROR", "submit_upstream_work stratum_send_line failed", 6), "DISCONNECTED"],
  [log("ERROR", "json_rpc_call failed, retry after 10 seconds", 7), "DISCONNECTED"],
  [log("ERROR", "Failed to open verthash data file.", 8), "CRASHED"],
  [log("ERROR", "cu_device(0):Failed to assign a CUDA device to thread. error code: 3", 9), "CRASHED"],
  [log("ERROR", "Verthash data out of memory error.", 10), "CRASHED"]
];

/** Deterministic, high-volume corpus for throughput and memory tests. */
function generateLines(count, { devices = 2 } = {}) {
  const out = new Array(count);
  let accepted = 0;
  let submitted = 0;

  for (let i = 0; i < count; i++) {
    const slot = i % (devices + 3);
    if (slot < devices) {
      out[i] = log("INFO", device("cu", slot, 200 + ((i * 7) % 50) + slot / 100, {
        err: 0,
        temp: 60 + (i % 12),
        power: 110 + (i % 40),
        fan: 40 + (i % 30)
      }), i);
    } else if (slot === devices) {
      submitted++;
      if (i % 17 !== 0) accepted++;
      out[i] = log("INFO", share(accepted, submitted, 400 + (i % 25)), i);
    } else if (slot === devices + 1) {
      out[i] = log("DEBUG", `< {"id":${i},"result":true,"error":null}`, i);
    } else {
      out[i] = log("INFO", `Stratum difficulty set to ${(0.0625 * (1 + (i % 4))).toFixed(4)}`, i);
    }
  }
  return out;
}

/** Hostile inputs: none of these may throw or corrupt state. */
const MALFORMED_LINES = [
  "",
  " ",
  "\u0000\u0001\u0002",
  "[not-a-timestamp] INFO  hello",
  "[2026-08-18 20:00:00] INFO",
  "[2026-08-18 20:00:00] BOGUS message",
  "accepted: not/a/number, total hashrate: NaN kH/s",
  "accepted: 9007199254740993/9007199254740994 (100.00%), total hashrate: 1e400 kH/s",
  "cu_device(): hashrate: kH/s",
  "cu_device(-1): hashrate: -5.00 kH/s",
  "cu_device(99999999999999999999): hashrate: 1e309 kH/s",
  "Stratum difficulty set to NaN",
  "Stratum difficulty set to -0",
  "Stratum difficulty set to 1e-05",
  '< {"id":1,"result":false,"error":[]}',
  '< {"id":1,"result":false,"error":[23,"' + "x".repeat(4096) + '"]}',
  "\u001b[31m[2026-08-18 20:00:00] ERROR\u001b[0m Stratum connection timed out",
  "x".repeat(200000),
  "accepted: 1/0 (inf%), total hashrate: 0.00 kH/s"
];

module.exports = {
  DEVICE_LIST_OUTPUT,
  SMI_OUTPUT,
  SESSION_LINES,
  SESSION_EXPECTED,
  FALSE_POSITIVE_LINES,
  FATAL_LINES,
  MALFORMED_LINES,
  generateLines,
  log,
  device,
  share,
  ts
};
