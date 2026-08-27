"use strict";
const { execFile } = require("node:child_process");
const { LIMITS } = require("../utils/constants");
const { clampGpuPollMs, GPU_POLL_DEFAULT_MS } = require("../utils/config");
const { normalizePci } = require("./devices");
const { unrefTimer } = require("../utils/timers");
const SMI_QUERY = Object.freeze(["--query-gpu=name,temperature.gpu,power.draw,utilization.gpu,clocks.gr,clocks.mem,memory.used,memory.total,pstate,pci.bus_id", "--format=csv,noheader,nounits"]);
const SMI_BIN = process.platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi";
const EXEC_TIMEOUT_MS = 1500;
function toNumber(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
class GpuManager {
  constructor({ state, pollMs = GPU_POLL_DEFAULT_MS, onUpdate, exec = execFile } = {}) {
    this.state = state;
    this.pollMs = clampGpuPollMs(pollMs);
    this.onUpdate = onUpdate;
    this.exec = exec;
    this.timer = null;
    this.busy = false;
    this.running = false;
  }
  _notify() {
    this.state.dirty = true;
    if (typeof this.onUpdate === "function") {
      try { this.onUpdate(); } catch (err) {}
    }
  }
  _poll() {
    if (!this.running) return;
    if (this.busy) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = unrefTimer(() => this._poll(), this.pollMs);
      return;
    }
    this.busy = true;
    this.exec(SMI_BIN, SMI_QUERY, { windowsHide: true, timeout: EXEC_TIMEOUT_MS, maxBuffer: LIMITS.GPU_MAX_BUFFER_BYTES }, (err, stdout) => {
      this.busy = false;
      if (!this.running) return;

      if (!err && stdout) {
        const trimmed = String(stdout).trim();
        if (trimmed) {
          const lines = trimmed.split("\n");
          this.state.gpuError = "";
          let validCount = 0;
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const p = line.split(",");
            const pciBusId = normalizePci((p[9] || "").trim());
            const name = (p[0] || "").trim() || `GPU ${validCount}`;
            const temperatureC = toNumber(p[1]);
            const powerW = toNumber(p[2]);
            const utilizationPct = toNumber(p[3]);
            const coreMHz = toNumber(p[4]);
            const memoryMHz = toNumber(p[5]);
            const memoryUsedMB = toNumber(p[6]);
            const memoryTotalMB = toNumber(p[7]);
            const pstate = (p[8] || "").trim() || null;
            if (validCount < this.state.gpu.length) {
              const g = this.state.gpu[validCount];
              g.name = name; g.temperatureC = temperatureC; g.powerW = powerW; g.utilizationPct = utilizationPct; g.coreMHz = coreMHz; g.memoryMHz = memoryMHz; g.memoryUsedMB = memoryUsedMB; g.memoryTotalMB = memoryTotalMB; g.pstate = pstate; g.pciBusId = pciBusId;
            } else {
              this.state.gpu.push({ index: validCount, name, temperatureC, powerW, utilizationPct, coreMHz, memoryMHz, memoryUsedMB, memoryTotalMB, pstate, pciBusId });
            }
            validCount++;
          }
          if (this.state.gpu.length > validCount) {
            this.state.gpu.length = validCount;
          }
          this._notify();
        }
      } else if (err) {
        const message = err.message || String(err);
        if (this.state.gpuError !== message) {
          this.state.gpuError = message;
          this._notify();
        }
      }

      if (this.running) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = unrefTimer(() => this._poll(), this.pollMs);
      }
    });
  }
  start() {
    if (this.running) return;
    this.running = true;
    if (this.timer) clearTimeout(this.timer);
    this._poll();
  }
  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.state.gpu.length > 0 || this.state.gpuError) {
      this.state.gpu = [];
      this.state.gpuError = "";
      this._notify();
    }
  }
  pollNow() {
    this.running = true;
    if (!this.busy) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this._poll();
    }
  }
}
module.exports = { GpuManager };
