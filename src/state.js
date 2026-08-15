const os = require("node:os");

class CircularLogBuffer {
  constructor(capacity = 50) {
    this.capacity = capacity;
    this.buf = new Array(capacity);
    this.head = 0;
    this.count = 0;
    this.seq = 0;
  }

  push(text, type = "info") {
    this.buf[this.head] = { id: ++this.seq, text, type };
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  toJSON() {
    return this.count < this.capacity
      ? this.buf.slice(0, this.count)
      : this.buf.slice(this.head).concat(this.buf.slice(0, this.head));
  }
}

function getServerTz() {
  const off = -(new Date().getTimezoneOffset());
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

const SERVER_TZ = getServerTz();
const HOSTNAME = os.hostname();

function createState(wallet = "", maxLogs = 50) {
  const logs = new CircularLogBuffer(maxLogs);
  return {
    startedAt: Date.now(),
    miner: {
      running: false,
      exitCode: null,
      signal: null,
      lastLine: "",
      lastError: "",
      logs,
      wallet
    },
    mining: {
      hashrateKHs: null,
      accepted: 0,
      submitted: 0,
      rejected: 0,
      difficulty: null,
      status: "STOPPED",
      lastAcceptedAt: null,
      gpuHashrates: {},
      seenDevices: [],
      hashratesReady: false,
      pciMap: {}
    },
    gpu: [],
    host: {
      hostname: HOSTNAME,
      tz: SERVER_TZ
    }
  };
}

function formatStatsSnapshot(state) {
  const now = Date.now();

  return {
    now,
    uptimeSeconds: Math.max(0, Math.floor((now - state.startedAt) / 1000)),
    acceptedRatio: state.mining.submitted > 0 ? (state.mining.accepted / state.mining.submitted) * 100 : null,
    startedAt: state.startedAt,
    miner: state.miner,
    mining: {
      hashrateKHs: state.mining.hashrateKHs,
      accepted: state.mining.accepted,
      submitted: state.mining.submitted,
      rejected: state.mining.rejected,
      difficulty: state.mining.difficulty,
      status: state.mining.status,
      lastAcceptedAt: state.mining.lastAcceptedAt
    },
    gpu: state.gpu.map(g => {
      const cuIndex = state.mining.pciMap[g.pciBusId] !== undefined 
        ? state.mining.pciMap[g.pciBusId] 
        : g.index;
      return {
        ...g,
        hashrate: state.mining.gpuHashrates[`cu_${cuIndex}`]
      };
    }),
    host: state.host
  };
}

module.exports = {
  createState,
  formatStatsSnapshot
};
