"use strict";

/** Miner lifecycle states shared by the parser, miner manager and client. */
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

/** Log severities understood by the console renderer. */
const LOG = Object.freeze({
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  SUCCESS: "success",
  ACCENT: "accent",
  SYSTEM: "system"
});

const LIMITS = Object.freeze({
  /** Maximum concurrent SSE subscribers. */
  MAX_SSE_CLIENTS: 4,
  /** Coalescing window for SSE broadcasts, in ms. */
  BROADCAST_MS: 50,
  /** SSE keep-alive comment interval, in ms. */
  HEARTBEAT_MS: 15000,
  /** Authenticated session lifetime, refreshed on activity. */
  SESSION_TTL_MS: 1800 * 1000,
  /** Lines retained while no client is attached, replayed on connect. */
  REPLAY_LINES: 25,
  /** Cap on a single stdout/stderr reassembly buffer. */
  STREAM_BUFFER_BYTES: 65536,
  /** Delay before a requested miner action executes, debouncing rapid clicks. */
  ACTION_DELAY_MS: 2000
});

module.exports = { STATUS, LOG, LIMITS };
