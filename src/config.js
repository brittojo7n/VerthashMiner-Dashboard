const fs = require("node:fs");
const path = require("node:path");

try {
  const envPath = path.join(path.resolve(__dirname, ".."), ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        process.env[match[1]] = (match[2] || "").replace(/^["']|["']$/g, "").trim();
      }
    }
  }
} catch { }

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const GPU_POLL_MS = Number(process.env.GPU_POLL_MS || 2000);
const MAX_LOGS = Math.min(500, Math.max(15, Number(process.env.MAX_LOGS || 50)));
const MINER_EXE = process.env.MINER_EXE || "VerthashMiner.exe";
const MINER_ARGS = ((process.env.MINER_ARGS || "").match(/"([^"]*)"|(\S+)/g) || []).map(m => m.replace(/^"|"$/g, ""));
const MINER_CWD = process.env.MINER_CWD || "";
const PASSPHRASE = process.env.PASSPHRASE || "";

if (!MINER_ARGS.includes("-P") && !MINER_ARGS.includes("--protocol-dump")) {
  MINER_ARGS.push("--protocol-dump");
}

let WALLET = "";
for (let i = 0; i < MINER_ARGS.length; i++) {
  const arg = MINER_ARGS[i];
  if ((arg === "-u" || arg === "--user") && i + 1 < MINER_ARGS.length) {
    WALLET = MINER_ARGS[i + 1].split(".")[0];
    break;
  } else if (arg.startsWith("-u=") || arg.startsWith("--user=")) {
    WALLET = arg.split("=")[1].split(".")[0];
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
  PASSPHRASE,
  WALLET
};
