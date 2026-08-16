const { execFile } = require("node:child_process");

const SMI_QUERY = [
  "--query-gpu=name,temperature.gpu,power.draw,utilization.gpu,clocks.gr,clocks.mem,memory.used,memory.total,pstate,pci.bus_id",
  "--format=csv,noheader,nounits"
];

function parseSmiOutput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const lines = trimmed.replace(/\r/g, "").split("\n");
  const result = new Array(lines.length);

  for (let i = 0; i < lines.length; i++) {
    const p = lines[i].split(",");
    const rawPci = (p[9] || "").trim();
    let pciBusId = rawPci;
    const m = rawPci.match(/([0-9a-fA-F]{2}):([0-9a-fA-F]{2})\.([0-9a-fA-F])/);
    if (m) pciBusId = `${m[1].toLowerCase()}:${m[2].toLowerCase()}:${m[3].toLowerCase()}`;

    result[i] = {
      index: i,
      name: (p[0] || "").trim() || `GPU ${i}`,
      temperatureC: Number(p[1]) || null,
      powerW: Number(p[2]) || null,
      utilizationPct: Number(p[3]) || null,
      coreMHz: Number(p[4]) || null,
      memoryMHz: Number(p[5]) || null,
      memoryUsedMB: Number(p[6]) || null,
      memoryTotalMB: Number(p[7]) || null,
      pstate: (p[8] || "").trim() || null,
      pciBusId
    };
  }
  return result;
}

class GpuManager {
  constructor({ state, pollMs = 5000, onUpdate }) {
    this.state = state;
    this.pollMs = pollMs;
    this.onUpdate = onUpdate;
    this.timer = null;
    this.busy = false;
    this.active = false;
  }

  poll() {
    if (this.busy || !this.active) return;
    this.busy = true;
    execFile("nvidia-smi.exe", SMI_QUERY, { windowsHide: true, timeout: 1500 }, (err, stdout) => {
      this.busy = false;
      if (!err && stdout) {
        this.state.gpu = parseSmiOutput(String(stdout));
        this.state.dirty = true;
        if (typeof this.onUpdate === "function") this.onUpdate();
      }
      if (this.active) {
        this.timer = setTimeout(() => this.poll(), this.pollMs);
      }
    });
  }

  updateSubscribers(n) {
    if (n > 0 && !this.active) {
      this.active = true;
      this.poll();
    } else if (n === 0 && this.active) {
      this.active = false;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.busy = false;
    }
  }

  stop() {
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.busy = false;
  }
}

module.exports = { GpuManager };
