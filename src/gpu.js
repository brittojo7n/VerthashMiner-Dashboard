const { execFile } = require("node:child_process");

const SMI_QUERY = [
  "--query-gpu=name,temperature.gpu,power.draw,utilization.gpu,clocks.gr,clocks.mem,memory.used,memory.total,pstate",
  "--format=csv,noheader,nounits"
];

function parseSmiOutput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const lines = trimmed.replace(/\r/g, "").split("\n");
  const result = new Array(lines.length);

  for (let i = 0; i < lines.length; i++) {
    const p = lines[i].split(",");
    result[i] = {
      index: i,
      name:            (p[0] || "").trim() || `GPU ${i}`,
      temperatureC:    Number(p[1]) || null,
      powerW:          Number(p[2]) || null,
      utilizationPct:  Number(p[3]) || null,
      coreMHz:         Number(p[4]) || null,
      memoryMHz:       Number(p[5]) || null,
      memoryUsedMB:    Number(p[6]) || null,
      memoryTotalMB:   Number(p[7]) || null,
      pstate:          (p[8] || "").trim() || null
    };
  }
  return result;
}

class GpuManager {
  constructor({ state, pollMs = 2000, onUpdate }) {
    this.state    = state;
    this.pollMs   = pollMs;
    this.onUpdate = onUpdate;
    this.timer    = null;
    this.busy     = false;
  }

  poll() {
    if (this.busy) return;
    this.busy = true;
    execFile("nvidia-smi.exe", SMI_QUERY, { windowsHide: true, timeout: 1500 }, (err, stdout) => {
      this.busy = false;
      if (!err && stdout) {
        this.state.gpu = parseSmiOutput(String(stdout));
        this.onUpdate();
      }
    });
  }

  updateSubscribers(n) {
    if (n > 0 && !this.timer) {
      this.poll();
      this.timer = setInterval(() => this.poll(), this.pollMs);
      this.timer.unref();
    } else if (n === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.busy  = false;
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.busy = false;
  }
}

module.exports = { GpuManager };
