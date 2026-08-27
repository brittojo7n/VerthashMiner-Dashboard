export const DASH = "\u2014";
const pad = (n) => String(n).padStart(2, "0");
export const num = (v, d = 1) => v == null || !Number.isFinite(v) ? DASH : Number(v).toFixed(d);
export function uptime(totalSeconds) {
  let s = Math.max(0, Math.floor(totalSeconds || 0));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); const sec = s % 60;
  return d > 0 ? `${d}d ${h}h ${m}m` : `${pad(h)}:${pad(m)}:${pad(sec)}`;
}
export function timestamp(ms, tz) {
  const d = new Date(ms);
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return tz ? `${base} (${tz})` : base;
}
export const stripLogPrefix = (text) => String(text).replace(/^\[[^\]]+\]\s*\w+\s*/, "");
const tempStatus = (t, levels) => t == null ? null : t >= levels.hot ? "danger" : t >= levels.warn ? "warn" : "ok";
export const IDLE_STATUS = new Set(["STOPPED", "CRASHED", "ERROR"]);
export const LIVE_STATUS = new Set(["MINING", "CONNECTED", "WAITING", "DISCONNECTED"]);
function effectiveStatus(snapshot, pending) {
  if (pending) return pending;
  const s = snapshot.mining.status;
  return !snapshot.miner.running && LIVE_STATUS.has(s) ? "STOPPED" : s;
}
export function dotClass(status) {
  if (IDLE_STATUS.has(status)) return "dot err";
  return status === "MINING" || status === "CONNECTED" ? "dot ok" : "dot warn";
}
export function sharesPerMinute(accepted, elapsedMs) {
  const spm = elapsedMs > 0 ? accepted / (elapsedMs / 60000) : accepted;
  return spm > 0 ? num(spm, 3) : DASH;
}
export function presentSnapshot(snapshot, options = {}) {
  const m = snapshot.mining;
  return {
    status: effectiveStatus(snapshot, options.pendingStatus || null),
    hashrate: num(m.hashrateKHs, 2),
    accepted: m.submitted === 0 ? DASH : `${m.accepted} / ${m.submitted}`,
    ratio: snapshot.acceptedRatio == null ? DASH : `${num(snapshot.acceptedRatio, 2)}%`,
    rejected: String(m.rejected),
    difficulty: m.difficulty == null ? DASH : String(m.difficulty),
    lastAccepted: m.lastAcceptedAt ? timestamp(m.lastAcceptedAt) : DASH,
    user: snapshot.miner.user || "",
    wallet: snapshot.miner.wallet || "",
    worker: snapshot.miner.worker || null,
    host: `Host: ${snapshot.host.hostname}`,
  };
}
export function presentGpu(gpu, opts = {}) {
  const levels = opts.tempLevels || { warn: 72, hot: 80 };
  const eff = gpu.hashrate > 0 && gpu.powerW > 0 ? gpu.hashrate / gpu.powerW : null;
  const util = gpu.utilizationPct == null ? 0 : Math.max(0, Math.min(100, gpu.utilizationPct));
  return {
    name: `GPU ${gpu.index} \u2022 ${gpu.name || "Unknown"}`,
    pstate: gpu.pstate || DASH,
    temp: gpu.temperatureC != null ? `${num(gpu.temperatureC, 0)}\u00b0C` : DASH,
    tempStatus: tempStatus(gpu.temperatureC, levels),
    power: num(gpu.powerW, 1), core: num(gpu.coreMHz, 0), mem: num(gpu.memoryMHz, 0),
    vramUsed: num(gpu.memoryUsedMB, 0), vramTotal: num(gpu.memoryTotalMB, 0),
    hashrate: gpu.hashrate != null ? num(gpu.hashrate, 2) : DASH,
    eff: eff != null ? num(eff, 2) : DASH, util: num(gpu.utilizationPct, 0), barScale: util / 100,
  };
}
