"use strict";

const { execFile } = require("node:child_process");
const { LIMITS } = require("../utils/constants");
const { clampGpuPollMs, GPU_POLL_DEFAULT_MS } = require("../utils/config");
const { normalizePci } = require("./devices");
const { unrefTimer } = require("../utils/timers");

const SMI_QUERY = Object.freeze([
  "--query-gpu=name,temperature.gpu,power.draw,utilization.gpu,clocks.gr,clocks.mem,memory.used,memory.total,pstate,pci.bus_id",
  "--format=csv,noheader,nounits",
]);
const SMI_BIN = process.platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi";
const EXEC_TIMEOUT_MS = 1500;

function toNumber(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function parseSmiOutput(raw) {
  const trimmed = String(raw).trim();
  if (!trimmed) return [];
  const lines = trimmed.split("\n");
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const p = line.split(",");
    const pciBusId = normalizePci((p[9] || "").trim());
    result.push({
      index: result.length,
      name: (p[0] || "").trim() || `GPU ${result.length}`,
      temperatureC: toNumber(p[1]),
      powerW: toNumber(p[2]),
      utilizationPct: toNumber(p[3]),
      coreMHz: toNumber(p[4]),
      memoryMHz: toNumber(p[5]),
      memoryUsedMB: toNumber(p[6]),
      memoryTotalMB: toNumber(p[7]),
      pstate: (p[8] || "").trim() || null,
      pciBusId,
    });
  }
  return result;
}

function sameTelemetry(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (
      x.temperatureC !== y.temperatureC ||
      x.powerW !== y.powerW ||
      x.utilizationPct !== y.utilizationPct ||
      x.coreMHz !== y.coreMHz ||
      x.memoryMHz !== y.memoryMHz ||
      x.memoryUsedMB !== y.memoryUsedMB ||
      x.pstate !== y.pstate ||
      x.name !== y.name ||
      x.pciBusId !== y.pciBusId
    )
      return false;
  }
  return true;
}

class GpuManager {
  constructor({ state, pollMs = GPU_POLL_DEFAULT_MS, onUpdate, exec = execFile } = {}) {
    this.state = state;
    this.pollMs = clampGpuPollMs(pollMs);
    this.onUpdate = onUpdate;
    this.exec = exec;
    this.timer = null;
    this.busy = false;
    this.active = false;
    this.lastPollAt = 0;
  }

  get intervalMs() {
    return this.pollMs;
  }

  _cooldownLeft() {
    if (!this.lastPollAt) return 0;
    const elapsed = Date.now() - this.lastPollAt;
    const interval = this.intervalMs;
    return elapsed >= interval ? 0 : interval - elapsed;
  }

  _arm(delay) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.active) return;
    this.timer = unrefTimer(() => {
      this.timer = null;
      this.poll();
    }, delay);
  }

  _notify() {
    this.state.dirty = true;
    if (typeof this.onUpdate === "function") {
      try {
        this.onUpdate();
      } catch (err) {
        console.error("[dashboard] gpu onUpdate failed:", err.message);
      }
    }
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
    this.exec(
      SMI_BIN,
      SMI_QUERY,
      {
        windowsHide: true,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: LIMITS.GPU_MAX_BUFFER_BYTES,
      },
      (err, stdout) => {
        this.busy = false;
        if (!err && stdout) {
          let parsed;
          try {
            parsed = parseSmiOutput(String(stdout));
          } catch (err) {
            console.error("[dashboard] gpu parse failed:", err.message);
            parsed = null;
          }
          if (parsed) {
            const changed = !sameTelemetry(this.state.gpu, parsed) || this.state.gpuError;
            this.state.gpu = parsed;
            this.state.gpuError = "";
            if (changed) this._notify();
          }
        } else if (err) {
          const message = err.message || String(err);
          if (this.state.gpuError !== message) {
            this.state.gpuError = message;
            this._notify();
          }
        }
        if (this.active) {
          const left = this._cooldownLeft();
          this._arm(left > 0 ? left : this.intervalMs);
        }
      },
    );
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
