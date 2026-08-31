"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { resolveIdentity } = require("../../web/lib/user");
const { parseMinerArgs } = require("./args");

const GPU_POLL_MS = 5000;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function parseEnvFile(text) {
  const out = Object.create(null);
  if (!text) return out;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.charCodeAt(0) === 35) continue;
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
  const target = envPath || env.ENV_FILE || path.join(path.resolve(__dirname, "..", ".."), ".env");
  try {
    if (!fs.existsSync(target)) return env;
    const parsed = parseEnvFile(fs.readFileSync(target, "utf8"));
    for (const key of Object.keys(parsed)) {
      if (env[key] === undefined) env[key] = parsed[key];
    }
  } catch (err) {
    console.error("[dashboard] env load failed:", err.message);
  }
  return env;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function splitArgs(raw) {
  return (String(raw || "").match(/"([^"]*)"|(\S+)/g) || []).map((token) => token.replace(/^"|"$/g, ""));
}

function parseIndexList(value) {
  if (!value) return null;
  const list = String(value).split(",").map((part) => Number.parseInt(part.trim(), 10)).filter(Number.isInteger);
  return list.length ? list : null;
}

function deviceSelection(flags) {
  return {
    cu: flags.allCuDevices ? null : parseIndexList(flags.cuDevices),
    cl: flags.allClDevices ? null : parseIndexList(flags.clDevices),
  };
}

function applyUserArg(args, user) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-u" || arg === "--user") {
      if (i + 1 < args.length) args[i + 1] = user;
      return;
    }
    if (arg.startsWith("-u=")) { args[i] = `-u=${user}`; return; }
    if (arg.startsWith("--user=")) { args[i] = `--user=${user}`; return; }
  }
}

function buildConfig(env = process.env, opts = {}) {
  const platform = opts.platform || process.platform;
  const warnings = [];
  const rawPort = env.PORT;
  const PORT = clampInt(rawPort, 0, 65535, 4067);
  if (rawPort != null && rawPort !== "" && Number(rawPort) !== PORT) warnings.push(`PORT "${rawPort}" is invalid; using ${PORT}.`);
  const HOST = env.HOST || "127.0.0.1";
  const MINER_EXE = env.MINER_EXE || (platform === "win32" ? "VerthashMiner.exe" : "VerthashMiner");
  const MINER_ARGS = splitArgs(env.MINER_ARGS);
  if (!MINER_ARGS.includes("-P") && !MINER_ARGS.includes("--protocol-dump")) MINER_ARGS.push("--protocol-dump");
  const flags = parseMinerArgs(MINER_ARGS);
  const identity = resolveIdentity(flags);
  if (identity.user) applyUserArg(MINER_ARGS, identity.user);
  return Object.freeze({
    PORT, HOST, GPU_POLL_MS,
    MINER_EXE, MINER_ARGS: Object.freeze(MINER_ARGS), MINER_CWD: env.MINER_CWD || "",
    PASSPHRASE: env.PASSPHRASE || "", SESSION_SECRET: env.SESSION_SECRET || "",
    USER: identity.user, WALLET: identity.wallet, WORKER: identity.worker,
    DEVICE_SELECTION: Object.freeze(deviceSelection(flags)),
    FORWARD_CONSOLE: String(env.FORWARD_CONSOLE).toLowerCase() === "true",
    warnings: Object.freeze(warnings),
  });
}

function validateConfig(config) {
  const fatal = [];
  if (!config.SESSION_SECRET) fatal.push("Missing SESSION_SECRET in .env file. Provide a random cryptographic string (e.g. 64 hex characters) to secure session cookies.");
  if (!LOCAL_HOSTS.has(config.HOST) && !config.PASSPHRASE) fatal.push(`Insecure configuration: HOST is bound to a non-local interface (${config.HOST}) without a PASSPHRASE. Set PASSPHRASE to prevent unauthorised access to your miner.`);
  return fatal;
}

loadEnvFile();
const config = buildConfig(process.env);

module.exports = Object.assign({}, config, { validateConfig, buildConfig, loadEnvFile, parseEnvFile, GPU_POLL_MS });
