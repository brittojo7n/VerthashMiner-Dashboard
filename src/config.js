const fs = require("node:fs");
const path = require("node:path");

function loadEnv(rootDir = path.resolve(__dirname, "..")) {
  try {
    const envPath = path.join(rootDir, ".env");
    if (!fs.existsSync(envPath)) return;

    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        const val = (match[2] || "").replace(/^["']|["']$/g, "").trim();
        process.env[key] = val;
      }
    }
  } catch { }
}

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const GPU_POLL_MS = Number(process.env.GPU_POLL_MS || 2000);
const MAX_LOGS = Math.min(500, Math.max(15, Number(process.env.MAX_LOGS || 50)));
const MINER_EXE = process.env.MINER_EXE || "VerthashMiner.exe";
const MINER_ARGS_RAW = process.env.MINER_ARGS || "";
const MINER_ARGS = (MINER_ARGS_RAW.match(/"([^"]*)"|(\S+)/g) || []).map(m => m.replace(/^"|"$/g, ""));
const MINER_CWD = process.env.MINER_CWD || "";
const TOKEN = process.env.DASHBOARD_TOKEN || "";

let WALLET = "";
for (let i = 0; i < MINER_ARGS.length; i++) {
  if ((MINER_ARGS[i] === "-u" || MINER_ARGS[i] === "--user") && i + 1 < MINER_ARGS.length) {
    WALLET = MINER_ARGS[i + 1].split(".")[0];
    break;
  }
}

module.exports = {
  PORT,
  HOST,
  GPU_POLL_MS,
  MAX_LOGS,
  MINER_EXE,
  MINER_ARGS,
  MINER_CWD,
  TOKEN,
  WALLET,
  loadEnv
};
