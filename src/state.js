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
      invalid: 0,
      difficulty: null,
      status: "STARTING",
      lastAcceptedAt: null
    },
    gpu: [],
    host: {
      hostname: os.hostname()
    }
  };
}

function formatStatsSnapshot(state) {
  const now = Date.now();
  const uptimeSeconds = Math.max(0, Math.floor((now - state.startedAt) / 1000));
  const acceptedRatio = state.mining.submitted > 0
    ? (state.mining.accepted / state.mining.submitted) * 100
    : null;

  return {
    now,
    uptimeSeconds,
    acceptedRatio,
    ...state
  };
}

module.exports = {
  CircularLogBuffer,
  createState,
  formatStatsSnapshot
};
