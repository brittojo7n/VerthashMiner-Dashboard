/**
 * Pure snapshot -> display-string projection.
 *
 * Every number the dashboard shows is produced here and nowhere else, so the
 * test suite can assert "what the UI displays" against the raw console log
 * without a browser, and the browser and the tests can never drift apart.
 */
import { num, uptime, timestamp, tempClass, DASH } from "./format.js";

/** Statuses that mean "the miner process is not running". */
export const IDLE_STATUS = new Set(["STOPPED", "CRASHED", "ERROR"]);

/** Statuses that mean "the miner process is up". */
export const LIVE_STATUS = new Set(["MINING", "CONNECTED", "WAITING", "DISCONNECTED"]);

/**
 * Status actually rendered in the pill.
 * A live status is downgraded to STOPPED when the supervisor reports the
 * process is gone, so the pill can never claim MINING for a dead miner.
 */
export function effectiveStatus(snapshot, pendingStatus) {
  if (pendingStatus) return pendingStatus;
  const status = snapshot.mining.status;
  return !snapshot.miner.running && LIVE_STATUS.has(status) ? "STOPPED" : status;
}

export function dotClass(status) {
  if (IDLE_STATUS.has(status)) return "dot err";
  return status === "MINING" || status === "CONNECTED" ? "dot ok" : "dot warn";
}

/**
 * Shares per minute, measured over the miner's own uptime.
 * @param {number} accepted accepted shares
 * @param {number} elapsedMs milliseconds since the miner started
 */
export function sharesPerMinute(accepted, elapsedMs) {
  const minutes = elapsedMs / 60000;
  const spm = minutes > 0 ? accepted / minutes : accepted;
  return spm > 0 ? num(spm, 3) : DASH;
}

/**
 * Projects a stats snapshot into the exact strings shown by the dashboard.
 *
 * @param {object} snapshot          payload from /api/status or the SSE stream
 * @param {object} [options]
 * @param {number} [options.now]     client-side "now" in server time
 * @param {string|null} [options.pendingStatus] optimistic status during an action
 */
export function presentSnapshot(snapshot, options = {}) {
  const m = snapshot.mining;
  const now = Number.isFinite(options.now) ? options.now : snapshot.now;
  const elapsed = Math.max(0, now - snapshot.startedAt);
  const status = effectiveStatus(snapshot, options.pendingStatus || null);

  return {
    status,
    dot: dotClass(status),
    actionLabel: IDLE_STATUS.has(status) ? "START" : "STOP",
    hashrate: num(m.hashrateKHs, 2),
    accepted: m.submitted === 0 ? DASH : `${m.accepted} / ${m.submitted}`,
    ratio: snapshot.acceptedRatio == null ? DASH : `${num(snapshot.acceptedRatio, 1)}%`,
    rejected: String(m.rejected),
    difficulty: m.difficulty == null ? DASH : String(m.difficulty),
    lastAccepted: m.lastAcceptedAt ? timestamp(m.lastAcceptedAt) : DASH,
    wallet: snapshot.miner.wallet || DASH,
    uptime: uptime(Math.floor(elapsed / 1000)),
    sharesPerMinute: sharesPerMinute(m.accepted, elapsed),
    host: `Host: ${snapshot.host.hostname}`
  };
}

/** Projects one GPU telemetry entry into its card values. */
export function presentGpu(gpu) {
  const eff = gpu.hashrate > 0 && gpu.powerW > 0 ? gpu.hashrate / gpu.powerW : null;
  const util = gpu.utilizationPct == null ? 0 : Math.max(0, Math.min(100, gpu.utilizationPct));

  return {
    name: `GPU ${gpu.index} \u2022 ${gpu.name || "Unknown"}`,
    pstate: gpu.pstate || DASH,
    temp: gpu.temperatureC != null ? `${num(gpu.temperatureC, 0)}\u00b0C` : DASH,
    tempClass: tempClass(gpu.temperatureC),
    power: num(gpu.powerW, 1),
    core: num(gpu.coreMHz, 0),
    mem: num(gpu.memoryMHz, 0),
    vramUsed: num(gpu.memoryUsedMB, 0),
    vramTotal: num(gpu.memoryTotalMB, 0),
    hashrate: gpu.hashrate != null ? num(gpu.hashrate, 2) : DASH,
    eff: eff != null ? num(eff, 2) : DASH,
    util: num(gpu.utilizationPct, 1),
    barWidth: `${util}%`
  };
}
