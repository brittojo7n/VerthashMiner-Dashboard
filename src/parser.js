"use strict";

/*
 * Line formats below are taken verbatim from the VerthashMiner sources
 * (github.com/CryptoGraphics/VerthashMiner):
 *
 *   applog()      src/vhCore/Util.cpp   "[%d-%02d-%02d %02d:%02d:%02d] %-5s %s\n"
 *                                       priorities: ERROR / WARN / INFO / DEBUG, written to stderr
 *   cu_device     src/main.cpp          "cu_device(%d):%s%s%s%s hashrate: %.02f kH/s"
 *   cl_device     src/main.cpp          "cl_device(%d):%s%s%s%s hashrate: %.02f kH/s"
 *                                       optional fields: " err:%u," " temp:%dC," " power:%dW," " fan:%d%%,"
 *   share result  src/main.cpp          "accepted: %lu/%lu (%.2f%%), total hashrate: %s"
 *                                       where %s is "%.2f kH/s" or the literal "(pending...)"
 *   difficulty    src/vhCore/Util.cpp   "Stratum difficulty set to %g"
 */
const { STATUS, LOG } = require("./constants");

const RX_NORM = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const RX_DEV_HASH = /(cu|cl)_device\((\d+)\).*?hashrate:\s*([\d.]+)/i;
const RX_DIFF = /difficulty(?:\s*(?:set|is))?\s*(?:to|:)?\s*([\d.]+)/i;
const RX_ACC = /accepted:\s*(\d+)\s*\/\s*(\d+)(?:.*?total hashrate:\s*([\d.]+|\(pending...\)))?/i;
// Miner memory-error counter (" err:%u,") is INFO-level telemetry on an otherwise
// healthy hashrate line, so it must not be matched here. Only treat a standalone
// "error(s): N" as an error, never the inline " err:N," device field.
const RX_NZERR = /\berrors?:\s*[1-9]\d*\b/i;
// Non-zero device memory errors still deserve a visible warning.
const RX_DEV_MEMERR = /\berr:\s*[1-9]\d*,/i;
const RX_FATAL = /\b(?:cuda\s+error|failed\s+to|fatal|exception|enoent)\b/i;
// Pool/stratum loss: the miner keeps running but is no longer mining, so these
// must move the dashboard off STATUS.MINING instead of silently leaving it green.
// Sources: main.cpp "Stratum connection timed out" / "Stratum connection interrupted",
//          Util.cpp "Stratum connection failed: %s".
const RX_STRATUM_DOWN = /stratum\s+connection\s+(?:failed|timed\s+out|interrupted)/i;
const RX_REJECT = /"result"\s*:\s*false\s*,\s*"error"\s*:\s*\[\s*\d+\s*,\s*"([^"]+)"/i;

function canSetRunStatus(state) {
  return !!(state.miner && state.miner.running && state.mining.status !== STATUS.STOPPING && state.mining.status !== STATUS.STOPPED);
}

function classifyLine(line, lc) {
  // applog prefix "[YYYY-MM-DD HH:MM:SS] LEVEL " -> ']' sits at index 20 and the
  // first letter of the space-padded level at index 22 (E)RROR / (W)ARN.
  if (line.length > 27 && line.charCodeAt(0) === 91 && line.charCodeAt(20) === 93) {
    const c = line.charCodeAt(22);
    if (c === 69) return { isFatal: RX_FATAL.test(line) || RX_STRATUM_DOWN.test(line), type: LOG.ERROR };
    if (c === 87) return { isFatal: false, type: LOG.WARN };
  }

  if (RX_FATAL.test(line)) return { isFatal: true, type: LOG.ERROR };
  if (RX_STRATUM_DOWN.test(line)) return { isFatal: true, type: LOG.ERROR };
  if (RX_NZERR.test(line)) return { isFatal: false, type: LOG.ERROR };
  // Device line reporting non-zero memory errors: warn, but keep it out of the
  // fatal path since the device is still hashing.
  if (RX_DEV_MEMERR.test(line)) return { isFatal: false, type: LOG.WARN };

  if (lc.includes("accepted:") || lc.includes("share accepted") || lc.includes("loaded succes") || lc.includes("verified succes") || lc.includes("successfully configured")) {
    return { isFatal: false, type: LOG.SUCCESS };
  }

  if (lc.includes("stratum") || lc.includes("difficulty") || lc.includes("hashrate:") || lc.includes("device")) {
    return { isFatal: false, type: LOG.ACCENT };
  }

  return { isFatal: false, type: LOG.INFO };
}

function parseMinerLine(raw, state, pushLog) {
  const line = String(raw).replace(RX_NORM, "").trim();
  if (!line) return;

  const lc = line.toLowerCase();
  const { isFatal, type } = classifyLine(line, lc);

  if (isFatal && canSetRunStatus(state)) {
    state.miner.lastError = line;
    // Losing the pool is recoverable: the miner stays alive and reconnects, so
    // report DISCONNECTED rather than CRASHED (which implies a dead process).
    state.mining.status = RX_STRATUM_DOWN.test(line) ? STATUS.DISCONNECTED : STATUS.CRASHED;
  }

  if (lc.includes("result") && lc.includes("false") && lc.includes("error")) {
    const rejectMatch = line.match(RX_REJECT);
    if (rejectMatch) {
      const reason = rejectMatch[1];
      state.mining.lastRejectReason = reason;
      if (typeof pushLog === "function") {
        pushLog(`[Stratum] Share Rejected: ${reason}`, LOG.ERROR);
      } else if (state.miner.logs) {
        state.miner.logs.push(`[Stratum] Share Rejected: ${reason}`, LOG.ERROR);
      }
    }
  }

  if (typeof pushLog === "function") {
    pushLog(line, type);
  } else if (state.miner.logs) {
    state.miner.logs.push(line, type);
    state.miner.lastLine = line;
  }

  if (lc.includes("hashrate:") || lc.includes("_device(")) {
    const devHashMatch = line.match(RX_DEV_HASH);
    if (devHashMatch) {
      const prefix = devHashMatch[1].toLowerCase();
      const id = devHashMatch[2];
      const hr = Number(devHashMatch[3]);
      const deviceKey = `${prefix}_${id}`;

      const oldHr = state.mining.gpuHashrates[deviceKey] || 0;
      state.mining.gpuHashrates[deviceKey] = hr;

      if (!state.mining.hashratesReady) {
        if (state.mining.seenDevices.includes(deviceKey)) {
          state.mining.hashratesReady = true;
        } else {
          state.mining.seenDevices.push(deviceKey);
        }
      }

      if (state.mining.hashratesReady) {
        if (state.mining.hashrateKHs == null || Number.isNaN(state.mining.hashrateKHs)) {
          let total = 0;
          for (const k in state.mining.gpuHashrates) {
            total += state.mining.gpuHashrates[k] || 0;
          }
          state.mining.hashrateKHs = total;
        } else {
          state.mining.hashrateKHs = Math.max(0, state.mining.hashrateKHs - oldHr + hr);
        }
      }

      if (hr > 0 && canSetRunStatus(state)) {
        state.mining.status = STATUS.MINING;
        if (!isFatal) state.miner.lastError = "";
      }
    }
  }

  if (lc.includes("difficulty")) {
    const diffMatch = line.match(RX_DIFF);
    if (diffMatch) state.mining.difficulty = Number(diffMatch[1]);
  }

  if (lc.includes("accepted:")) {
    const acc = line.match(RX_ACC);
    if (acc) {
      state.mining.accepted = Number(acc[1]);
      state.mining.submitted = Number(acc[2]);
      state.mining.rejected = state.mining.submitted - state.mining.accepted;
      if (state.mining.rejected < 0) state.mining.rejected = 0;
      if (canSetRunStatus(state)) {
        state.mining.status = STATUS.MINING;
        state.miner.lastError = "";
      }
      state.mining.lastAcceptedAt = Date.now();

      if (acc[3] && acc[3] !== "(pending...)") {
        state.mining.hashrateKHs = Number(acc[3]);
      }
    }
  }

  if (!isFatal && canSetRunStatus(state) && state.mining.status !== STATUS.MINING) {
    if (lc.includes("stratum") && lc.includes("connect")) {
      state.mining.status = STATUS.CONNECTED;
    } else if (lc.includes("waiting") || lc.includes("paused") || lc.includes("no work")) {
      state.mining.status = STATUS.WAITING;
    }
  }
}

module.exports = { parseMinerLine };
