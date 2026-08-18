"use strict";

const { STATUS, LOG } = require("./constants");

const RX_NORM = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const RX_DEV_HASH = /(cu|cl)_device\((\d+)\).*?hashrate:\s*([\d.]+)/i;
const RX_DIFF = /difficulty(?:\s*(?:set|is))?\s*(?:to|:)?\s*([+-]?[\d.]+([eE][+-]?\d+)?)/i;
const RX_JSON_DIFF = /"mining\.set_difficulty".*?"params"\s*:\s*\[\s*([+-]?[\d.]+([eE][+-]?\d+)?)\s*\]/i;
const RX_ACC = /accepted:\s*(\d+)\s*\/\s*(\d+)(?:.*?total hashrate:\s*([\d.]+|\(pending...\)))?/i;

const RX_NZERR = /\berrors?:\s*[1-9]\d*\b/i;

const RX_DEV_MEMERR = /\berr:\s*[1-9]\d*,/i;
const RX_FATAL = /\b(?:cuda\s+error|failed\s+to|fatal|exception|enoent)\b/i;

const RX_STRATUM_DOWN = /stratum\s+connection\s+(?:failed|timed\s+out|interrupted)/i;
const RX_REJECT = /"result"\s*:\s*(?:false|null)\s*,\s*"error"\s*:\s*\[\s*\d+\s*,\s*"([^"]+)"/i;

function canSetRunStatus(state) {
  return !!(state.miner && state.miner.running && state.mining.status !== STATUS.STOPPING && state.mining.status !== STATUS.STOPPED);
}

function classifyLine(line, lc) {
  if (line.length > 27 && line.charCodeAt(0) === 91 && line.charCodeAt(20) === 93) {
    const c = line.charCodeAt(22);
    if (c === 69) return { isFatal: RX_FATAL.test(line) || RX_STRATUM_DOWN.test(line), type: LOG.ERROR };
    if (c === 87) return { isFatal: false, type: LOG.WARN };
  }

  if (RX_FATAL.test(line)) return { isFatal: true, type: LOG.ERROR };
  if (RX_STRATUM_DOWN.test(line)) return { isFatal: true, type: LOG.ERROR };
  if (RX_NZERR.test(line)) return { isFatal: false, type: LOG.ERROR };

  if (RX_DEV_MEMERR.test(line)) return { isFatal: false, type: LOG.WARN };

  if (lc.includes("accepted:") || lc.includes("share accepted") || lc.includes("loaded succes") || lc.includes("verified succes") || lc.includes("successfully configured")) {
    return { isFatal: false, type: LOG.SUCCESS };
  }

  if (lc.includes("stratum") || lc.includes("difficulty") || lc.includes("hashrate:") || lc.includes("device") || lc.includes("mining.set_difficulty")) {
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

    state.mining.status = RX_STRATUM_DOWN.test(line) ? STATUS.DISCONNECTED : STATUS.CRASHED;
  }

  if (lc.includes("result") && lc.includes("error") && !lc.includes('"error":null') && !lc.includes('"error": null')) {
    const rejectMatch = line.match(RX_REJECT);
    if (rejectMatch) {
      const reason = rejectMatch[1];
      state.mining.lastRejectReason = reason;
      state.mining.lastJsonRejectTime = Date.now();
      if (typeof pushLog === "function") {
        pushLog(`[Stratum] Share Rejected: ${reason}`, LOG.ERROR);
      } else if (state.miner.logs) {
        state.miner.logs.push(`[Stratum] Share Rejected: ${reason}`, LOG.ERROR);
      }
    }
  }

  // Prevent spamming UI with raw JSON debug logs unless it's a critical error
  const isJsonProtocol = lc.includes('"id":') || lc.includes('"method":');
  if (!isJsonProtocol) {
    if (typeof pushLog === "function") {
      pushLog(line, type);
    } else if (state.miner.logs) {
      state.miner.logs.push(line, type);
      state.miner.lastLine = line;
    }
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

  let diffValue = null;
  if (lc.includes("mining.set_difficulty")) {
    const jsonDiffMatch = line.match(RX_JSON_DIFF);
    if (jsonDiffMatch) diffValue = Number(jsonDiffMatch[1]);
  } else if (lc.includes("difficulty")) {
    const diffMatch = line.match(RX_DIFF);
    if (diffMatch) diffValue = Number(diffMatch[1]);
  }

  if (diffValue !== null && !Number.isNaN(diffValue)) {
    state.mining.difficulty = diffValue;
  }

  if (lc.includes("accepted:")) {
    const acc = line.match(RX_ACC);
    if (acc) {
      state.mining.accepted = Number(acc[1]);
      state.mining.submitted = Number(acc[2]);
      
      let newRejected = state.mining.submitted - state.mining.accepted;
      if (newRejected < 0) newRejected = 0;
      
      if (newRejected > state.mining.rejected && state.mining.rejected >= 0) {
        const diff = newRejected - state.mining.rejected;
        const msSinceJsonReject = Date.now() - (state.mining.lastJsonRejectTime || 0);
        
        // Failsafe: Log missing rejections if JSON didn't catch them
        if (msSinceJsonReject > 2000) {
          const msg = `[Stratum] ${diff} Share(s) Rejected (Failsafe)`;
          if (typeof pushLog === "function") {
            pushLog(msg, LOG.ERROR);
          } else if (state.miner.logs) {
            state.miner.logs.push(msg, LOG.ERROR);
          }
        }
      }
      state.mining.rejected = newRejected;
      
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
