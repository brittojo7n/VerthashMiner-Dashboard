"use strict";

const STATUS = Object.freeze({
  STARTING: "STARTING",
  STOPPING: "STOPPING",
  RESTARTING: "RESTARTING",
  STOPPED: "STOPPED",
  CRASHED: "CRASHED",
  MINING: "MINING",
  CONNECTED: "CONNECTED",
  WAITING: "WAITING",
  DISCONNECTED: "DISCONNECTED"
});

const LOG = Object.freeze({
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  SUCCESS: "success",
  ACCENT: "accent",
  SYSTEM: "system"
});

const LIMITS = Object.freeze({
  /** Hard cap on concurrent SSE subscribers. */
  MAX_SSE_CLIENTS: 4,

  /** Coalescing window for outbound stat broadcasts. */
  BROADCAST_MS: 50,

  /** SSE comment heartbeat so proxies do not drop idle streams. */
  HEARTBEAT_MS: 15000,

  /** Rolling session lifetime. */
  SESSION_TTL_MS: 1800 * 1000,

  REPLAY_LINES: 25,

  /** Upper bound for the partial-line buffer of a child stream. */
  STREAM_BUFFER_BYTES: 65536,

  /** Debounce between a UI control press and the actual lifecycle call. */
  ACTION_DELAY_MS: 2000,

  /** `--device-list` probe must never be able to wedge a miner start. */
  PROBE_TIMEOUT_MS: 8000,

  /** SIGINT -> SIGKILL escalation window. */
  FORCE_KILL_MS: 2000,

  /** Absolute ceiling for a stop() call; resolves even if the child never exits. */
  STOP_TIMEOUT_MS: 10000,

  /** Gap between stop and start during a restart. */
  RESTART_GAP_MS: 500,

  /** Watchdog for the whole process shutdown sequence. */
  SHUTDOWN_TIMEOUT_MS: 12000,

  /** Consecutive nvidia-smi failures before the poll interval is backed off. */
  GPU_FAILURE_BACKOFF_AFTER: 3,

  /** Ceiling for the backed-off nvidia-smi poll interval. */
  GPU_BACKOFF_MAX_MS: 120000,

  /** Bytes of nvidia-smi stdout we are willing to buffer. */
  GPU_MAX_BUFFER_BYTES: 262144,

  /** Consecutive backpressure skips before an SSE client is dropped. */
  SSE_MAX_BLOCKED_TICKS: 5
});

module.exports = { STATUS, LOG, LIMITS };
