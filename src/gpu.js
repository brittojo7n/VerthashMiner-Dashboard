const { execFile } = require("node:child_process");
const { clampGpuPollMs, GPU_POLL_DEFAULT_MS } = require("./config");

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
  constructor({ state, pollMs = GPU_POLL_DEFAULT_MS, onUpdate }) {
    this.state = state;
    this.pollMs = clampGpuPollMs(pollMs);
    this.onUpdate = onUpdate;
    this.timer = null;
    this.busy = false;
    this.active = false;
    this.lastPollAt = 0;
  }

  _cooldownLeft() {
    if (!this.lastPollAt) return 0;
    const elapsed = Date.now() - this.lastPollAt;
    return elapsed >= this.pollMs ? 0 : this.pollMs - elapsed;
  }

  _arm(delay) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.active) return;
    this.timer = setTimeout(() => this.poll(), delay);
  }

  poll() {
    if (!this.active || this.busy) return;

    const wait = this._cooldownLeft();
    if (wait > 0) {
      if (!this.timer) this._arm(wait);
      return;
    }

    this.busy = true;
    this.lastPollAt = Date.now();
    execFile("nvidia-smi.exe", SMI_QUERY, { windowsHide: true, timeout: 1500 }, (err, stdout) => {
      this.busy = false;
      if (!err && stdout) {
        this.state.gpu = parseSmiOutput(String(stdout));
        this.state.gpuError = "";
        this.state.dirty = true;
        if (typeof this.onUpdate === "function") this.onUpdate();
      } else if (err) {
        this.state.gpuError = err.message || String(err);
        this.state.dirty = true;
        if (typeof this.onUpdate === "function") this.onUpdate();
      }
      if (this.active) {
        const wait = this._cooldownLeft();
        this._arm(wait > 0 ? wait : this.pollMs);
      }
    });
  }

  updateSubscribers(n) {
    if (n > 0) {
      if (!this.active) {
        this.active = true;
        this.poll();
      }
    } else if (this.active) {
      this.active = false;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }
  }

  stop() {
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

module.exports = { GpuManager };
