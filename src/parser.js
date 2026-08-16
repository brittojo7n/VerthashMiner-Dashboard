const RX_NORM = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const RX_DEV_HASH = /(cu|cl)_device\((\d+)\).*?hashrate:\s*([\d.]+)/i;
const RX_DIFF = /difficulty(?:\s*(?:set|is))?\s*(?:to|:)?\s*([\d.]+)/i;
const RX_ACC = /accepted:\s*(\d+)\s*\/\s*(\d+)(?:.*?total hashrate:\s*([\d.]+|\(pending...\)))?/i;
const RX_NZERR = /\b(?:errors?|err):\s*[1-9]\d*\b/i;
const RX_FATAL = /\b(?:cuda\s+error|failed\s+to|fatal|exception|enoent)\b/i;
const RX_REJECT = /"result"\s*:\s*false\s*,\s*"error"\s*:\s*\[\s*\d+\s*,\s*"([^"]+)"/i;

function classifyLine(line, lc) {
  if (line.length > 27 && line.charCodeAt(0) === 91 && line.charCodeAt(20) === 93) {
    const c = line.charCodeAt(22);
    if (c === 69) return { isFatal: RX_FATAL.test(line), type: "error" };
    if (c === 87) return { isFatal: false, type: "warn" };
  }

  if (RX_FATAL.test(line)) return { isFatal: true, type: "error" };
  if (RX_NZERR.test(line)) return { isFatal: false, type: "error" };

  if (lc.includes("accepted:") || lc.includes("share accepted") || lc.includes("loaded succes") || lc.includes("verified succes") || lc.includes("successfully configured")) {
    return { isFatal: false, type: "success" };
  }

  if (lc.includes("stratum") || lc.includes("difficulty") || lc.includes("hashrate:") || lc.includes("device")) {
    return { isFatal: false, type: "accent" };
  }

  return { isFatal: false, type: "info" };
}

function parseMinerLine(raw, state, pushLog) {
  const line = String(raw).replace(RX_NORM, "").trim();
  if (!line) return;

  const lc = line.toLowerCase();
  const { isFatal, type } = classifyLine(line, lc);

  if (isFatal) {
    state.miner.lastError = line;
    state.mining.status = "CRASHED";
  }

  if (lc.includes("result") && lc.includes("false") && lc.includes("error")) {
    const rejectMatch = line.match(RX_REJECT);
    if (rejectMatch) {
      const reason = rejectMatch[1];
      state.mining.lastRejectReason = reason;
      if (typeof pushLog === "function") {
        pushLog(`[Stratum] Share Rejected: ${reason}`, "error");
      } else if (state.miner.logs) {
        state.miner.logs.push(`[Stratum] Share Rejected: ${reason}`, "error");
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

      if (hr > 0) {
        state.mining.status = "MINING";
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
      state.mining.status = "MINING";
      state.mining.lastAcceptedAt = Date.now();
      state.miner.lastError = "";

      if (acc[3] && acc[3] !== "(pending...)") {
        state.mining.hashrateKHs = Number(acc[3]);
      }
    }
  }

  if (!isFatal && state.mining.status !== "MINING") {
    if (lc.includes("stratum") && lc.includes("connect")) {
      state.mining.status = "CONNECTED";
    } else if (lc.includes("waiting") || lc.includes("paused") || lc.includes("no work")) {
      state.mining.status = "WAITING";
    }
  }
}

module.exports = { parseMinerLine };
