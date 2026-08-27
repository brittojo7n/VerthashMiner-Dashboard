"use strict";

const { STATUS, LOG } = require("../utils/constants");
const { stripAnsi } = require("./devices");

const RX_DEV_HASH = /(cu|cl)_device\((\d+)\).*?hashrate:\s*([\d.]+)/i;
const RX_DIFF =
  /difficulty(?:\s*(?:set|is))?\s*(?:to|:)?\s*([+-]?[\d.]+(?:[eE][+-]?\d+)?)/i;
const RX_JSON_DIFF =
  /"mining\.set_difficulty".*?"params"\s*:\s*\[\s*([+-]?[\d.]+(?:[eE][+-]?\d+)?)\s*\]/i;
const RX_ACC =
  /accepted:\s*(\d+)\s*\/\s*(\d+)(?:.*?total hashrate:\s*([\d.]+|\(pending\.\.\.\)))?/i;
const RX_WORKERS =
  /configured\s+(\d+)\(cl\)(?:\s+and\s+(\d+)\(cuda\))?\s+workers/i;
const RX_THREADS = /(\d+)\s+miner threads started/i;
const RX_NZERR = /\berrors?:\s*[1-9]\d*\b/i;
const RX_DEV_MEMERR = /\berr:\s*[1-9]\d*,/i;
const RX_FATAL =
  /\b(?:cuda\s+error|failed\s+to|fatal|exception|enoent|out\s+of\s+memory)\b/i;
const RX_POOL_DOWN =
  /stratum[\s_](?:connection\s+(?:failed|timed\s+out|interrupted)|recv_line\s+(?:timed\s+out|failed)|subscribe\s+(?:send\s+)?(?:failed|timed\s+out)|send_line\s+failed|authentication\s+failed|thread\s+create\s+failed)|json_rpc_call\s+failed/i;
const RX_REJECT =
  /"result"\s*:\s*(?:false|null)\s*,\s*"error"\s*:\s*\[\s*\d+\s*,\s*"([^"]+)"/i;
const LEVELS = new Set(["ERROR", "WARN", "INFO", "DEBUG"]);

function levelOf(line) {
  if (
    line.length < 28 ||
    line.charCodeAt(0) !== 91 ||
    line.charCodeAt(20) !== 93 ||
    line.charCodeAt(21) !== 32
  )
    return null;
  const level = line.slice(22, 27).trim();
  return LEVELS.has(level) ? level : null;
}

function canSetRunStatus(state) {
  const status = state.mining.status;
  return Boolean(
    state.miner &&
      state.miner.running &&
      status !== STATUS.RESTARTING &&
      status !== STATUS.STOPPING &&
      status !== STATUS.STOPPED,
  );
}

function deviceIndexFor(state, prefix, workerIndex) {
  const map = state.mining.workerMap && state.mining.workerMap[prefix];
  if (Array.isArray(map) && workerIndex < map.length) return map[workerIndex];
  return workerIndex;
}

function classifyLine(line, lc, level) {
  if (level === "ERROR") {
    const isPoolDown = RX_POOL_DOWN.test(line);
    return { isFatal: isPoolDown || RX_FATAL.test(line), isPoolDown, type: LOG.ERROR };
  }
  if (level === "WARN") return { isFatal: false, isPoolDown: false, type: LOG.WARN };
  if (level === null) {
    if (RX_POOL_DOWN.test(line)) return { isFatal: true, isPoolDown: true, type: LOG.ERROR };
    if (RX_FATAL.test(line)) return { isFatal: true, isPoolDown: false, type: LOG.ERROR };
  }
  if (RX_NZERR.test(line)) return { isFatal: false, isPoolDown: false, type: LOG.ERROR };
  if (RX_DEV_MEMERR.test(line)) return { isFatal: false, isPoolDown: false, type: LOG.WARN };
  
  if (/(?:accepted:|share accepted|loaded succes|verified succes|successfully configured)/i.test(lc))
    return { isFatal: false, isPoolDown: false, type: LOG.SUCCESS };
  if (/(?:stratum|difficulty|hashrate:|device|mining\.set_difficulty)/i.test(lc))
    return { isFatal: false, isPoolDown: false, type: LOG.ACCENT };
    
  return { isFatal: false, isPoolDown: false, type: LOG.INFO };
}

function sumDeviceHashrates(rates) {
  let total = 0;
  for (const key in rates) {
    const value = rates[key];
    if (Number.isFinite(value)) total += value;
  }
  return Math.round(total * 1e6) / 1e6;
}

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

function parseMinerLine(raw, state, pushLog) {
  const source = typeof raw === "string" ? raw : String(raw);
  const clean = source.indexOf("\u001b") === -1 ? source : stripAnsi(source);
  const line = clean.trim();
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

  if (lc.includes('"result"') && lc.includes('"error"')) {
    const rejectMatch = RX_REJECT.exec(line);
    if (rejectMatch) {
      mining.jsonRejects = (mining.jsonRejects || 0) + 1;
      emitLog(
        state,
        pushLog,
        `[Stratum] Share Rejected: ${rejectMatch[1]}`,
        LOG.ERROR,
      );
    }
  }

  const isJsonProtocol = lc.includes('"id":') || lc.includes('"method":');
  if (!isJsonProtocol) emitLog(state, pushLog, line, type);

  if (lc.includes("hashrate:") || lc.includes("_device(")) {
    const devHashMatch = RX_DEV_HASH.exec(line);
    if (devHashMatch) {
      const prefix = devHashMatch[1].toLowerCase();
      const worker = Number(devHashMatch[2]);
      const hr = Number(devHashMatch[3]);
      if (Number.isFinite(hr)) {
        const deviceKey = `${prefix}_${deviceIndexFor(state, prefix, worker)}`;
        mining.gpuHashrates[deviceKey] = hr;
        if (hashratesReady(state, deviceKey))
          mining.hashrateKHs = sumDeviceHashrates(mining.gpuHashrates);
        state.dirty = true;
        if (
          hr > 0 &&
          canSetRunStatus(state) &&
          mining.status !== STATUS.DISCONNECTED
        ) {
          mining.status = STATUS.MINING;
          if (!isFatal) state.miner.lastError = "";
        }
      }
    }
  }

  if (mining.expectedWorkers === 0) {
    const workers = RX_WORKERS.exec(line);
    if (workers) {
      mining.expectedWorkers =
        Number(workers[1] || 0) + Number(workers[2] || 0);
      state.dirty = true;
    } else if (level !== null) {
      const threads = RX_THREADS.exec(line);
      if (threads) {
        mining.expectedWorkers = Number(threads[1]);
        state.dirty = true;
      }
    }
  }

  let diffValue = null;
  if (lc.includes("mining.set_difficulty")) {
    const jsonDiff = RX_JSON_DIFF.exec(line);
    if (jsonDiff) diffValue = Number(jsonDiff[1]);
  } else if (lc.includes("difficulty")) {
    const diff = RX_DIFF.exec(line);
    if (diff) diffValue = Number(diff[1]);
  }
  if (
    diffValue !== null &&
    Number.isFinite(diffValue) &&
    mining.difficulty !== diffValue
  ) {
    mining.difficulty = diffValue;
    state.dirty = true;
  }

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
          const unexplained =
            rejected - Math.max(mining.jsonRejects || 0, mining.rejected);
          if (unexplained > 0)
            emitLog(
              state,
              pushLog,
              `[Stratum] ${unexplained} Share(s) Rejected (Failsafe)`,
              LOG.ERROR,
            );
        }
        mining.rejected = rejected;
        mining.lastAcceptedAt = Date.now();
        if (canSetRunStatus(state)) {
          mining.status = STATUS.MINING;
          state.miner.lastError = "";
        }
        if (acc[3] && acc[3] !== "(pending...)") {
          const total = Number(acc[3]);
          if (Number.isFinite(total)) mining.hashrateKHs = total;
        }
        state.dirty = true;
      }
    }
  }

  if (!isFatal && canSetRunStatus(state) && mining.status !== STATUS.MINING) {
    let next = null;
    if (
      lc.includes("starting stratum") ||
      (lc.includes("stratum") && lc.includes("connect"))
    )
      next = STATUS.CONNECTED;
    else if (
      lc.includes("waiting") ||
      lc.includes("paused") ||
      lc.includes("no work")
    )
      next = STATUS.WAITING;
    if (next && mining.status !== next) {
      mining.status = next;
      state.dirty = true;
    }
  }
}

module.exports = { parseMinerLine };
