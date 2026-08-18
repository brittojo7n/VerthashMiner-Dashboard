"use strict";

/**
 * Independent reference implementation ("oracle") of the metrics a
 * VerthashMiner console log implies.
 *
 * It deliberately shares **no code** with `src/parser.js`: it is written in a
 * plain, slow, obviously-correct style (string splitting instead of the
 * production regexes) so that agreement between the two is real evidence of
 * correctness rather than a tautology.
 */

const LEVELS = ["ERROR", "WARN ", "INFO ", "DEBUG"];

function splitLine(line) {
  // "[YYYY-MM-DD HH:MM:SS] LEVEL message"
  if (line.length > 27 && line[0] === "[" && line[20] === "]") {
    const level = line.slice(22, 27);
    if (LEVELS.includes(level)) {
      return { level: level.trim(), message: line.slice(28) };
    }
  }
  return { level: null, message: line };
}

function readNumberAfter(text, marker) {
  const at = text.toLowerCase().indexOf(marker);
  if (at === -1) return null;
  const rest = text.slice(at + marker.length);
  const match = rest.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  return match ? Number(match[0]) : null;
}

/**
 * Folds a list of console lines into the metrics the dashboard must display.
 *
 * @param {string[]} lines
 * @param {{devices?: Record<string, number>}} [seed]
 */
function reduceLog(lines, seed = {}) {
  const perDevice = { ...(seed.devices || {}) };
  let accepted = 0;
  let submitted = 0;
  let difficulty = null;
  let total = null;
  let status = "STARTING";
  let lastError = "";
  let workers = 0;
  let rejectReasons = 0;

  for (const raw of lines) {
    const line = String(raw).replace(/\u001b\[[0-9;]*m/g, "").trim();
    if (!line) continue;
    const { level, message } = splitLine(line);
    const lower = message.toLowerCase();

    // ---- worker banner
    const workerMatch = message.match(/Configured (\d+)\(CL\) and (\d+)\(CUDA\) workers/);
    if (workerMatch) workers = Number(workerMatch[1]) + Number(workerMatch[2]);

    // ---- per-device hashrate
    const devMatch = message.match(/^(cu|cl)_device\((\d+)\):/);
    if (devMatch && lower.includes("hashrate:")) {
      const value = readNumberAfter(message, "hashrate:");
      if (value !== null) {
        perDevice[`${devMatch[1]}_${devMatch[2]}`] = value;
        if (value > 0) status = "MINING";
        if (workers === 0 || Object.keys(perDevice).length >= workers) {
          total = Object.values(perDevice).reduce((a, b) => a + b, 0);
        }
      }
    }

    // ---- difficulty (protocol dump wins when present on the same line)
    if (message.includes("mining.set_difficulty")) {
      const params = message.match(/"params"\s*:\s*\[\s*([-\d.eE+]+)\s*\]/);
      if (params) difficulty = Number(params[1]);
    } else if (lower.includes("difficulty")) {
      const value = readNumberAfter(message, "difficulty");
      if (value !== null && Number.isFinite(value)) difficulty = value;
    }

    // ---- share results
    if (lower.startsWith("accepted:")) {
      const counts = message.match(/accepted:\s*(\d+)\/(\d+)/);
      if (counts) {
        accepted = Number(counts[1]);
        submitted = Number(counts[2]);
        status = "MINING";
        lastError = "";
        const rateAt = message.indexOf("total hashrate:");
        if (rateAt !== -1) {
          const tail = message.slice(rateAt + "total hashrate:".length).trim();
          if (!tail.startsWith("(pending")) {
            const value = Number.parseFloat(tail);
            if (Number.isFinite(value)) total = value;
          }
        }
      }
    }

    // ---- rejects reported by the stratum protocol dump
    if (/"result"\s*:\s*(false|null)\s*,\s*"error"\s*:\s*\[\s*\d+\s*,\s*"/.test(message)) {
      rejectReasons++;
    }

    // ---- terminal conditions
    if (level === "ERROR") {
      const poolDown =
        /stratum[\s_](connection (failed|timed out|interrupted)|recv_line (timed out|failed)|subscribe|send_line failed|authentication failed|thread create failed)/i.test(
          message
        ) || /json_rpc_call failed/i.test(message);
      const fatal =
        poolDown ||
        /(cuda error|failed to|fatal|exception|enoent|out of memory)/i.test(message);
      if (fatal) {
        status = poolDown ? "DISCONNECTED" : "CRASHED";
        lastError = line;
      }
    }
  }

  return {
    accepted,
    submitted,
    rejected: Math.max(0, submitted - accepted),
    difficulty,
    hashrateKHs: total,
    status,
    lastError,
    workers,
    perDevice,
    rejectReasons,
    acceptedRatio: submitted > 0 ? (accepted / submitted) * 100 : null
  };
}

module.exports = { reduceLog, splitLine };
