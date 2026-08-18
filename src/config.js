"use strict";

const fs = require("node:fs");
const path = require("node:path");

const GPU_POLL_MIN_MS = 3000;
const GPU_POLL_MAX_MS = 10000;
const GPU_POLL_DEFAULT_MS = 5000;
const MAX_LOGS_MIN = 15;
const MAX_LOGS_MAX = 500;
const MAX_LOGS_DEFAULT = 50;
const WEAK_SECRET_LENGTH = 32;

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function parseEnvFile(text) {
  const out = Object.create(null);
  if (!text) return out;

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.charCodeAt(0) === 35 ) continue;

    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match) continue;

    let val = match[2] || "";
    const quote = val[0];
    if (quote === '"' || quote === "'") {
      const end = val.lastIndexOf(quote);
      val = end > 0 ? val.slice(1, end) : val.slice(1);
    } else {
      const comment = val.indexOf(" #");
      if (comment !== -1) val = val.slice(0, comment);
      val = val.trim();
    }
    out[match[1]] = val;
  }
  return out;
}

function loadEnvFile(envPath, env = process.env) {
  const target =
    envPath || env.ENV_FILE || path.join(path.resolve(__dirname, ".."), ".env");
  try {
    if (!fs.existsSync(target)) return env;
    const parsed = parseEnvFile(fs.readFileSync(target, "utf8"));
    for (const key of Object.keys(parsed)) {
      if (env[key] === undefined) env[key] = parsed[key];
    }
  } catch {
  }
  return env;
}

function clampGpuPollMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return GPU_POLL_DEFAULT_MS;
  return Math.min(GPU_POLL_MAX_MS, Math.max(GPU_POLL_MIN_MS, Math.round(n)));
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function splitArgs(raw) {
  return (String(raw || "").match(/"([^"]*)"|(\S+)/g) || []).map(token =>
    token.replace(/^"|"$/g, "")
  );
}

function argValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (names.includes(arg)) return i + 1 < args.length ? args[i + 1] : "";
    for (const name of names) {
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return null;
}

function parseIndexList(value) {
  if (!value) return null;
  const list = String(value)
    .split(",")
    .map(part => Number.parseInt(part.trim(), 10))
    .filter(Number.isInteger);
  return list.length ? list : null;
}

function deviceSelection(args) {
  const all = flag => args.includes(flag);
  return {
    cu: all("--all-cu-devices") ? null : parseIndexList(argValue(args, ["--cu-devices", "-D"])),
    cl: all("--all-cl-devices") ? null : parseIndexList(argValue(args, ["--cl-devices", "-d"]))
  };
}

function extractWallet(args) {
  const raw = argValue(args, ["-u", "--user"]);
  return raw ? String(raw).split(".")[0] : "";
}

function buildConfig(env = process.env, opts = {}) {
  const platform = opts.platform || process.platform;
  const warnings = [];

  const rawPort = env.PORT;

  const PORT = clampInt(rawPort, 0, 65535, 3000);
  if (rawPort != null && rawPort !== "" && Number(rawPort) !== PORT) {
    warnings.push(`PORT "${rawPort}" is invalid; using ${PORT}.`);
  }

  const HOST = env.HOST || "127.0.0.1";

  const rawGpuPoll = env.GPU_POLL_MS;
  const GPU_POLL_MS = clampGpuPollMs(rawGpuPoll || GPU_POLL_DEFAULT_MS);
  if (rawGpuPoll != null && rawGpuPoll !== "" && Number(rawGpuPoll) !== GPU_POLL_MS) {
    warnings.push(
      `GPU_POLL_MS clamped to ${GPU_POLL_MS}ms (allowed ${GPU_POLL_MIN_MS}-${GPU_POLL_MAX_MS}).`
    );
  }

  const rawMaxLogs = env.MAX_LOGS;
  const MAX_LOGS = clampInt(rawMaxLogs, MAX_LOGS_MIN, MAX_LOGS_MAX, MAX_LOGS_DEFAULT);
  if (rawMaxLogs != null && rawMaxLogs !== "" && Number(rawMaxLogs) !== MAX_LOGS) {
    warnings.push(`MAX_LOGS clamped to ${MAX_LOGS} (allowed ${MAX_LOGS_MIN}-${MAX_LOGS_MAX}).`);
  }

  const MINER_EXE =
    env.MINER_EXE || (platform === "win32" ? "VerthashMiner.exe" : "VerthashMiner");

  const MINER_ARGS = splitArgs(env.MINER_ARGS);

  if (!MINER_ARGS.includes("-P") && !MINER_ARGS.includes("--protocol-dump")) {
    MINER_ARGS.push("--protocol-dump");
  }

  return Object.freeze({
    PORT,
    HOST,
    GPU_POLL_MS,
    GPU_POLL_MIN_MS,
    GPU_POLL_MAX_MS,
    GPU_POLL_DEFAULT_MS,
    clampGpuPollMs,
    MAX_LOGS,
    MINER_EXE,
    MINER_ARGS: Object.freeze(MINER_ARGS),
    MINER_CWD: env.MINER_CWD || "",
    PASSPHRASE: env.PASSPHRASE || "",
    SESSION_SECRET: env.SESSION_SECRET || "",
    WALLET: extractWallet(MINER_ARGS),
    DEVICE_SELECTION: Object.freeze(deviceSelection(MINER_ARGS)),
    FORWARD_CONSOLE: env.FORWARD_CONSOLE === "true",
    warnings: Object.freeze(warnings)
  });
}

function validateConfig(config) {
  const fatal = [];

  if (!config.SESSION_SECRET) {
    fatal.push(
      "Missing SESSION_SECRET in .env file. Provide a random cryptographic string " +
        "(e.g. 64 hex characters) to secure session cookies."
    );
  }

  if (!LOCAL_HOSTS.has(config.HOST) && !config.PASSPHRASE) {
    fatal.push(
      `Insecure configuration: HOST is bound to a non-local interface (${config.HOST}) ` +
        "without a PASSPHRASE. Set PASSPHRASE to prevent unauthorised access to your miner."
    );
  }

  return fatal;
}

function advisories(config) {
  const notes = [...config.warnings];

  if (config.SESSION_SECRET && config.SESSION_SECRET.length < WEAK_SECRET_LENGTH) {
    notes.push(
      `SESSION_SECRET is only ${config.SESSION_SECRET.length} characters; ` +
        `use at least ${WEAK_SECRET_LENGTH} for a meaningful security margin.`
    );
  }
  if (config.PASSPHRASE && config.PASSPHRASE.length < 8) {
    notes.push("PASSPHRASE is shorter than 8 characters and is trivially brute-forced.");
  }
  if (!LOCAL_HOSTS.has(config.HOST)) {
    notes.push(
      "Dashboard is reachable from the LAN over plain HTTP; never forward this port to the internet."
    );
  }
  return notes;
}

loadEnvFile();

const config = buildConfig(process.env);

module.exports = Object.assign({}, config, {
  buildConfig,
  validateConfig,
  advisories,
  parseEnvFile,
  loadEnvFile,
  splitArgs,
  clampGpuPollMs
});
