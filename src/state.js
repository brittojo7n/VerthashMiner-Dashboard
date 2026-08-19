"use strict";

const os = require("node:os");
const { STATUS } = require("./constants");

const MAX_ID = 0x7fffffff;

class CircularLogBuffer {
  constructor(capacity = 50) {
    this.capacity = Math.max(1, capacity | 0);
    this.buf = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
    this.seq = 0;
  }

  push(text, type = "info") {
    this.buf[this.head] = { id: ++this.seq, text, type };
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    return this.seq;
  }

  get firstId() {
    return this.count === 0 ? 0 : this.seq - this.count + 1;
  }

  get length() {
    return this.count;
  }

  toJSON() {
    return this.count < this.capacity
      ? this.buf.slice(0, this.count)
      : this.buf.slice(this.head).concat(this.buf.slice(0, this.head));
  }

  since(sinceId) {
    if (!Number.isFinite(sinceId) || sinceId <= 0) return this.toJSON();
    if (sinceId >= this.seq) return [];
    const missing = this.seq - sinceId;
    if (missing >= this.count) return this.toJSON();
    const out = new Array(missing);
    for (let i = 0; i < missing; i++) {
      const idx = (this.head - missing + i + this.capacity) % this.capacity;
      out[i] = this.buf[idx];
    }
    return out;
  }

  clear() {
    this.buf.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}

function getServerTz() {
  const off = -new Date().getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

const SERVER_TZ = getServerTz();
const HOSTNAME = os.hostname();

const EMPTY_HASH = Object.create(null);
const EMPTY_WORKER = null;

function createState(wallet = "", maxLogs = 50) {
  return {
    dirty: true,
    startedAt: Date.now(),
    gpuError: "",
    miner: {
      running: false,
      pid: null,
      startedAt: null,
      exitCode: null,
      signal: null,
      lastLine: "",
      lastError: "",
      logs: new CircularLogBuffer(maxLogs),
      wallet
    },
    mining: {
      hashrateKHs: null,
      accepted: 0,
      submitted: 0,
      rejected: 0,
      difficulty: null,
      status: STATUS.STOPPED,
      lastAcceptedAt: null,
      gpuHashrates: EMPTY_HASH,
      seenDevices: [],
      hashratesReady: false,
      expectedWorkers: 0,
      workerMap: EMPTY_WORKER,
      jsonRejects: 0,
      pciMap: Object.create(null)
    },
    gpu: [],
    host: {
      hostname: HOSTNAME,
      tz: SERVER_TZ
    }
  };
}

function hashrateForGpu(state, gpu) {
  const mapped = state.mining.pciMap[gpu.pciBusId];
  const devIndex = mapped !== undefined ? mapped : gpu.index;
  const rates = state.mining.gpuHashrates;
  const cuda = rates[`cu_${devIndex}`];
  return cuda !== undefined ? cuda : rates[`cl_${devIndex}`];
}

function formatStatsSnapshot(state, options) {
  const now = Date.now();
  const { miner, mining } = state;
  const minerStart = miner.startedAt || state.startedAt;
  const logs = miner.logs;

  const sinceId = options && Number.isFinite(options.logsSince) ? options.logsSince : 0;
  const entries = sinceId > 0 ? logs.since(sinceId) : logs.toJSON();
  const logsFrom = entries.length ? entries[0].id : logs.seq + 1;

  const gpu = new Array(state.gpu.length);
  for (let i = 0; i < state.gpu.length; i++) {
    const g = state.gpu[i];
    gpu[i] = {
      index: g.index,
      name: g.name,
      temperatureC: g.temperatureC,
      powerW: g.powerW,
      utilizationPct: g.utilizationPct,
      coreMHz: g.coreMHz,
      memoryMHz: g.memoryMHz,
      memoryUsedMB: g.memoryUsedMB,
      memoryTotalMB: g.memoryTotalMB,
      pstate: g.pstate,
      pciBusId: g.pciBusId,
      hashrate: hashrateForGpu(state, g)
    };
  }

  return {
    now,
    uptimeSeconds: miner.running && minerStart ? Math.max(0, Math.floor((now - minerStart) / 1000)) : 0,
    acceptedRatio: mining.submitted > 0 ? (mining.accepted / mining.submitted) * 100 : null,
    startedAt: minerStart,
    miner: {
      running: miner.running,
      pid: miner.pid,
      startedAt: miner.startedAt,
      exitCode: miner.exitCode,
      signal: miner.signal,
      lastLine: miner.lastLine,
      lastError: miner.lastError,
      wallet: miner.wallet,
      logs: entries
    },
    logsFrom,
    logSeq: logs.seq,
    logCount: logs.length,
    logCapacity: logs.capacity,
    mining: {
      hashrateKHs: mining.hashrateKHs,
      accepted: mining.accepted,
      submitted: mining.submitted,
      rejected: mining.rejected,
      difficulty: mining.difficulty,
      status: mining.status,
      lastAcceptedAt: mining.lastAcceptedAt
    },
    gpuError: state.gpuError || "",
    gpu,
    host: state.host
  };
}

module.exports = {
  CircularLogBuffer,
  createState,
  formatStatsSnapshot,
  hashrateForGpu
};
