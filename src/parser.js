"use strict";

const { STATUS, LOG } = require("./constants");

/* --------------------------------------------------------------------------
 * VerthashMiner emits every line through one applog() call:
 *
 *     [YYYY-MM-DD HH:MM:SS] LEVEL message        (LEVEL padded to 5 chars)
 *
 * Offsets are therefore fixed: '[' at 0, ']' at 20, level at 22..26,
 * message from 28. Trusting the level word (instead of keyword sniffing every
 * line) is what stops informational lines such as
 * "DEBUG Failed to get Stratum session id" from being reported as a crash.
 * -------------------------------------------------------------------------- */

const RX_ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const RX_DEV_HASH = /(cu|cl)_device\((\d+)\).*?hashrate:\s*([\d.]+)/i;
const RX_DIFF = /difficulty(?:\s*(?:set|is))?\s*(?:to|:)?\s*([+-]?[\d.]+(?:[eE][+-]?\d+)?)/i;
const RX_JSON_DIFF =
  /"mining\.set_difficulty".*?"params"\s*:\s*\[\s*([+-]?[\d.]+(?:[eE][+-]?\d+)?)\s*\]/i;
const RX_ACC = /accepted:\s*(\d+)\s*\/\s*(\d+)(?:.*?total hashrate:\s*([\d.]+|\(pending\.\.\.\)))?/i;
const RX_WORKERS = /configured\s+(\d+)\(cl\)(?:\s+and\s+(\d+)\(cuda\))?\s+workers/i;
const RX_THREADS = /^(\d+)\s+miner threads started/i;
const RX_NZERR = /\berrors?:\s*[1-9]\d*\b/i;
const RX_DEV_MEMERR = /\berr:\s*[1-9]\d*,/i;
const RX_FATAL = /\b(?:cuda\s+error|failed\s+to|fatal|exception|enoent|out\s+of\s+memory)\b/i;

/**
 * Every upstream message that means "the pool link is gone". None of them
 * contain a generic fatal keyword, so they need to be listed explicitly.
 */
const RX_POOL_DOWN =
  /stratum[\s_](?:connection\s+(?:failed|timed\s+out|interrupted)|recv_line\s+(?:timed\s+out|failed)|subscribe\s+(?:send\s+)?(?:failed|timed\s+out)|send_line\s+failed|authentication\s+failed|thread\s+create\s+failed)|json_rpc_call\s+failed/i;

const RX_REJECT = /"result"\s*:\s*(?:false|null)\s*,\s*"error"\s*:\s*\[\s*\d+\s*,\s*"([^"]+)"/i;

const LEVELS = new Set(["ERROR", "WARN", "INFO", "DEBUG"]);
const REJECT_CORRELATION_MS = 2000;

/** Extracts the applog level of a line, or null when the line is not applog output. */
function levelOf(line) {
  if (
    line.length < 28 ||
    line.charCodeAt(0) !== 91 /* [ */ ||
    line.charCodeAt(20) !== 93 /* ] */ ||
    line.charCodeAt(21) !== 32 /* space */
  ) {
    return null;
  }
  const level = line.slice(22, 27).trim();
  return LEVELS.has(level) ? level : null;
}

function canSetRunStatus(state) {
  const status = state.mining.status;
  return Boolean(
    state.miner &&
      state.miner.running &&
      status !== STATUS.STOPPING &&
      status !== STATUS.STOPPED
  );
}

/**
 * Maps a VerthashMiner *worker* slot to the device index the dashboard uses as
 * a join key. They differ only when the user selects a device subset
 * (`--cu-devices 1,3` => worker 0 is device 1).
 */
function deviceIndexFor(state, prefix, workerIndex) {
  const map = state.mining.workerMap && state.mining.workerMap[prefix];
  if (Array.isArray(map) && workerIndex < map.length) return map[workerIndex];
  return workerIndex;
}

/**
 * @param {string} line     ANSI-stripped line
 * @param {string} lc       lower-cased line (computed once by the caller)
 * @param {string|null} level applog level when present
 */
function classifyLine(line, lc, level) {
  if (level === "ERROR") {
    const isPoolDown = RX_POOL_DOWN.test(line);
    // Only genuinely terminal errors change the reported status. A transient
    // applog ERROR (a bad JSON key, a stale share) must not fake a crash.
    return {
      isFatal: isPoolDown || RX_FATAL.test(line),
      isPoolDown,
      type: LOG.ERROR
    };
  }
  if (level === "WARN") {
    return { isFatal: false, isPoolDown: false, type: LOG.WARN };
  }

  if (level === null) {
    // Not applog output (wrapper messages, raw stdout, foreign tools):
    // fall back to keyword heuristics.
    if (RX_POOL_DOWN.test(line)) return { isFatal: true, isPoolDown: true, type: LOG.ERROR };
    if (RX_FATAL.test(line)) return { isFatal: true, isPoolDown: false, type: LOG.ERROR };
  }

  if (RX_NZERR.test(line)) return { isFatal: false, isPoolDown: false, type: LOG.ERROR };
  if (RX_DEV_MEMERR.test(line)) return { isFatal: false, isPoolDown: false, type: LOG.WARN };

  if (
    lc.includes("accepted:") ||
    lc.includes("share accepted") ||
    lc.includes("loaded succes") ||
    lc.includes("verified succes") ||
    lc.includes("successfully configured")
  ) {
    return { isFatal: false, isPoolDown: false, type: LOG.SUCCESS };
  }

  if (
    lc.includes("stratum") ||
    lc.includes("difficulty") ||
    lc.includes("hashrate:") ||
    lc.includes("device") ||
    lc.includes("mining.set_difficulty")
  ) {
    return { isFatal: false, isPoolDown: false, type: LOG.ACCENT };
  }

  return { isFatal: false, isPoolDown: false, type: LOG.INFO };
}

/** Exact sum of the per-device rates; cheap (device counts are single digits). */
function sumDeviceHashrates(rates) {
  let total = 0;
  for (const key in rates) {
    const value = rates[key];
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

/**
 * True once every configured worker has reported at least one hashrate, so the
 * displayed total can never be a partial sum presented as a full-rig figure.
 * Falls back to the "a device reported twice" heuristic when the worker count
 * is unknown (e.g. the banner line was rotated out before a client attached).
 */
function hashratesReady(state, deviceKey) {
  const mining = state.mining;
  if (mining.hashratesReady) return true;

  const known = Object.keys(mining.gpuHashrates).length;
  if (mining.expectedWorkers > 0) {
    if (known >= mining.expectedWorkers) mining.hashratesReady = true;
    return mining.hashratesReady;
  }

  if (mining.seenDevices.includes(deviceKey)) mining.hashratesReady = true;
  else mining.seenDevices.push(deviceKey);
  return mining.hashratesReady;
}

function emitLog(state, pushLog, text, type) {
  if (typeof pushLog === "function") {
    pushLog(text, type);
    return;
  }
  if (state.miner.logs) {
    state.miner.logs.push(text, type);
    state.miner.lastLine = text;
    state.dirty = true;
  }
}

/**
 * Parses one miner console line and folds it into `state`.
 * The function is pure with respect to I/O: it only mutates `state` and calls
 * the supplied `pushLog` sink, which makes it directly testable.
 *
 * @param {string} raw      raw console line (ANSI allowed)
 * @param {object} state    state object from `createState()`
 * @param {(text: string, type: string) => void} [pushLog]
 */
function parseMinerLine(raw, state, pushLog) {
  const line = String(raw).replace(RX_ANSI, "").trim();
  if (!line) return;

  const level = levelOf(line);
  const lc = line.toLowerCase();
  const { isFatal, isPoolDown, type } = classifyLine(line, lc, level);
  const mining = state.mining;

  if (isFatal && canSetRunStatus(state)) {
    state.miner.lastError = line;
    mining.status = isPoolDown ? STATUS.DISCONNECTED : STATUS.CRASHED;
    state.dirty = true;
  }

  // Stratum protocol dump: surface reject reasons the summary line only counts.
  if (lc.includes('"result"') && lc.includes('"error"')) {
    const rejectMatch = RX_REJECT.exec(line);
    if (rejectMatch) {
      mining.lastJsonRejectTime = Date.now();
      emitLog(state, pushLog, `[Stratum] Share Rejected: ${rejectMatch[1]}`, LOG.ERROR);
    }
  }

  // Raw JSON protocol frames stay out of the UI console; they are noise there
  // and every value they carry is extracted below.
  const isJsonProtocol = lc.includes('"id":') || lc.includes('"method":');
  if (!isJsonProtocol) emitLog(state, pushLog, line, type);

  /* ---- per-device hashrate ------------------------------------------------ */
  if (lc.includes("hashrate:") || lc.includes("_device(")) {
    const devHashMatch = RX_DEV_HASH.exec(line);
    if (devHashMatch) {
      const prefix = devHashMatch[1].toLowerCase();
      const worker = Number(devHashMatch[2]);
      const hr = Number(devHashMatch[3]);

      if (Number.isFinite(hr)) {
        const deviceKey = `${prefix}_${deviceIndexFor(state, prefix, worker)}`;
        mining.gpuHashrates[deviceKey] = hr;

        if (hashratesReady(state, deviceKey)) {
          // Recomputed from scratch: no incremental float drift, and it mirrors
          // exactly how the miner derives "total hashrate".
          mining.hashrateKHs = sumDeviceHashrates(mining.gpuHashrates);
        }
        state.dirty = true;

        if (hr > 0 && canSetRunStatus(state)) {
          mining.status = STATUS.MINING;
          if (!isFatal) state.miner.lastError = "";
        }
      }
    }
  }

  /* ---- worker count (makes the total-hashrate gate exact) ----------------- */
  if (mining.expectedWorkers === 0) {
    const workers = RX_WORKERS.exec(line);
    if (workers) {
      mining.expectedWorkers = Number(workers[1] || 0) + Number(workers[2] || 0);
      state.dirty = true;
    } else if (level !== null) {
      const threads = RX_THREADS.exec(line.slice(28));
      if (threads) {
        mining.expectedWorkers = Number(threads[1]);
        state.dirty = true;
      }
    }
  }

  /* ---- difficulty --------------------------------------------------------- */
  let diffValue = null;
  if (lc.includes("mining.set_difficulty")) {
    const jsonDiff = RX_JSON_DIFF.exec(line);
    if (jsonDiff) diffValue = Number(jsonDiff[1]);
  } else if (lc.includes("difficulty")) {
    const diff = RX_DIFF.exec(line);
    if (diff) diffValue = Number(diff[1]);
  }
  if (diffValue !== null && Number.isFinite(diffValue) && mining.difficulty !== diffValue) {
    mining.difficulty = diffValue;
    state.dirty = true;
  }

  /* ---- share accounting --------------------------------------------------- */
  if (lc.includes("accepted:")) {
    const acc = RX_ACC.exec(line);
    if (acc) {
      const accepted = Number(acc[1]);
      const submitted = Number(acc[2]);

      if (Number.isFinite(accepted) && Number.isFinite(submitted)) {
        mining.accepted = accepted;
        mining.submitted = submitted;

        const rejected = Math.max(0, submitted - accepted);
        if (rejected > mining.rejected) {
          const delta = rejected - mining.rejected;
          const sinceJsonReject = Date.now() - (mining.lastJsonRejectTime || 0);
          // Failsafe: the protocol dump normally reports the reason. If it did
          // not (dump disabled, line dropped), still tell the operator.
          if (sinceJsonReject > REJECT_CORRELATION_MS) {
            emitLog(
              state,
              pushLog,
              `[Stratum] ${delta} Share(s) Rejected (Failsafe)`,
              LOG.ERROR
            );
          }
        }
        mining.rejected = rejected;
        mining.lastAcceptedAt = Date.now();

        if (canSetRunStatus(state)) {
          mining.status = STATUS.MINING;
          state.miner.lastError = "";
        }

        // Authoritative rig total straight from the miner.
        if (acc[3] && acc[3] !== "(pending...)") {
          const total = Number(acc[3]);
          if (Number.isFinite(total)) mining.hashrateKHs = total;
        }
        state.dirty = true;
      }
    }
  }

  /* ---- coarse connection state ------------------------------------------- */
  if (!isFatal && canSetRunStatus(state) && mining.status !== STATUS.MINING) {
    let next = null;
    if (lc.includes("stratum") && lc.includes("connect")) next = STATUS.CONNECTED;
    else if (lc.includes("waiting") || lc.includes("paused") || lc.includes("no work")) {
      next = STATUS.WAITING;
    }
    if (next && mining.status !== next) {
      mining.status = next;
      state.dirty = true;
    }
  }
}

module.exports = {
  parseMinerLine,
  classifyLine,
  levelOf,
  sumDeviceHashrates,
  RX_POOL_DOWN,
  RX_FATAL
};
