const fs = require("node:fs");
const path = require("node:path");

try {
  const envPath = path.join(path.resolve(__dirname, ".."), ".env");
  if (fs.existsSync(envPath)) {
    for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.charCodeAt(0) === 35) continue;
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (!match) continue;
      let val = match[2] || "";
      const q = val[0];
      if (q === "\"" || q === "'") {
        const end = val.lastIndexOf(q);
        val = end > 0 ? val.slice(1, end) : val.slice(1);
      } else {
        const hash = val.indexOf(" #");
        if (hash !== -1) val = val.slice(0, hash);
      }
      process.env[match[1]] = val.trim();
    }
  }
} catch { }

const GPU_POLL_MIN_MS = 3000;
const GPU_POLL_MAX_MS = 10000;
const GPU_POLL_DEFAULT_MS = 5000;

function clampGpuPollMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return GPU_POLL_DEFAULT_MS;
  return Math.min(GPU_POLL_MAX_MS, Math.max(GPU_POLL_MIN_MS, Math.round(n)));
}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const rawGpuPoll = process.env.GPU_POLL_MS;
const GPU_POLL_MS = clampGpuPollMs(rawGpuPoll || GPU_POLL_DEFAULT_MS);
if (rawGpuPoll != null && rawGpuPoll !== "" && Number(rawGpuPoll) !== GPU_POLL_MS) {
  console.log(`[dashboard] GPU_POLL_MS clamped to ${GPU_POLL_MS}ms (allowed ${GPU_POLL_MIN_MS}-${GPU_POLL_MAX_MS})`);
}
const MAX_LOGS = Math.min(500, Math.max(15, Number(process.env.MAX_LOGS || 50)));
const MINER_EXE = process.env.MINER_EXE || "VerthashMiner.exe";
const MINER_ARGS = ((process.env.MINER_ARGS || "").match(/\"([^\"]*)\"|(\S+)/g) || []).map(m => m.replace(/^\"|\"$/g, ""));
const MINER_CWD = process.env.MINER_CWD || "";
const PASSPHRASE = process.env.PASSPHRASE || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";

const FORWARD_CONSOLE = process.env.FORWARD_CONSOLE === "true";

if (!SESSION_SECRET) {
  console.error("[FATAL] Missing SESSION_SECRET in .env file.");
  console.error("[FATAL] You must provide a random cryptographic string to secure session cookies.");
  process.exit(1);
}

if (HOST !== "127.0.0.1" && HOST !== "localhost" && !PASSPHRASE) {
  console.error(`[FATAL] Insecure configuration detected!`);
  console.error(`[FATAL] You have bound the dashboard to a non-local interface (${HOST}) without setting a PASSPHRASE.`);
  console.error(`[FATAL] To prevent unauthorized access to your miner from the network, you are strictly required to set a PASSPHRASE.`);
  console.error(`[FATAL] The dashboard will now shut down.`);
  process.exit(1);
}

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
  GPU_POLL_MIN_MS,
  GPU_POLL_MAX_MS,
  GPU_POLL_DEFAULT_MS,
  clampGpuPollMs,
  MAX_LOGS,
  MINER_EXE,
  MINER_ARGS,
  MINER_CWD,
  PASSPHRASE,
  SESSION_SECRET,
  WALLET,
  FORWARD_CONSOLE
};
