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
  MAX_SSE_CLIENTS: 4,

  BROADCAST_MS: 50,

  HEARTBEAT_MS: 15000,

  SESSION_TTL_MS: 1800 * 1000,

  REPLAY_LINES: 25,

  STREAM_BUFFER_BYTES: 65536,

  ACTION_DELAY_MS: 2000
});

module.exports = { STATUS, LOG, LIMITS };
