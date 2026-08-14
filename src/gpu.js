const { execFile } = require("node:child_process");

const SMI_ARGS = [
  "--query-gpu=name,temperature.gpu,power.draw,utilization.gpu,clocks.gr,clocks.mem,memory.used,memory.total,pstate",
  "--format=csv,noheader,nounits"
];

function parseSmiOutput(output) {
  if (!output || !output.trim()) return [];

  return output.trim().split(/\r?\n/).map((line, index) => {
    const parts = line.split(",");
    return {
      index,
      name: (parts[0] || "").trim() || `GPU ${index}`,
      temperatureC: Number(parts[1]) || null,
      powerW: Number(parts[2]) || null,
      utilizationPct: Number(parts[3]) || null,
      coreMHz: Number(parts[4]) || null,
      memoryMHz: Number(parts[5]) || null,
      memoryUsedMB: Number(parts[6]) || null,
      memoryTotalMB: Number(parts[7]) || null,
      pstate: (parts[8] || "").trim() || null
    };
  });
}

function queryGpu(state, onSuccess, onComplete) {
  execFile("nvidia-smi.exe", SMI_ARGS, { windowsHide: true, timeout: 1500 }, (err, stdout) => {
    if (!err && stdout) {
      state.gpu = parseSmiOutput(String(stdout));
      if (typeof onSuccess === "function") onSuccess();
    }
    if (typeof onComplete === "function") onComplete(err, stdout);
  });
}

class GpuManager {
  constructor({ state, pollMs = 2000, onUpdate }) {
    this.state = state;
    this.pollMs = pollMs;
    this.onUpdate = onUpdate;
    this.timer = null;
    this.isPolling = false;
  }

  poll() {
    if (this.isPolling) return;
    this.isPolling = true;

    queryGpu(this.state, this.onUpdate, () => {
      this.isPolling = false;
    });
  }

  updateSubscribers(subscriberCount) {
    if (subscriberCount > 0 && !this.timer) {
      this.poll();
      this.timer = setInterval(() => this.poll(), this.pollMs);
    } else if (subscriberCount === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.isPolling = false;
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isPolling = false;
  }
}

module.exports = {
  SMI_ARGS,
  parseSmiOutput,
  queryGpu,
  GpuManager
};
