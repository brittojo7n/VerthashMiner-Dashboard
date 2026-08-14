const http = require("node:http");
const { spawn, execFile } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

try {
  const envData = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  envData.split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m) process.env[m[1]] = (m[2] || "").replace(/(^"|"$)/g, "");
  });
} catch (e) {}

const parseCmdArgs = str => {
  if (!str || typeof str !== "string") return [];
  const args = [], regex = /"([^"]*)"|([^\s]+)/g;
  let match;
  while ((match = regex.exec(str)) !== null) args.push(match[1] !== undefined ? match[1] : match[2]);
  return args;
};

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const POLL_MS = Number(process.env.GPU_POLL_MS || 3000);
const MINER_EXE = process.env.MINER_EXE || "VerthashMiner.exe";
const MINER_ARGS = parseCmdArgs(process.env.MINER_ARGS);
const MINER_CWD = process.env.MINER_CWD || process.cwd();
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "";
const INDEX_HTML = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");

const state = {
  startedAt: Date.now(),
  miner: { running: false, exitCode: null, signal: null, lastLine: "", lastError: "", restarts: 0 },
  mining: { hashrateKHs: null, accepted: 0, submitted: 0, rejected: 0, invalid: 0, difficulty: null, status: "STARTING", lastAcceptedAt: null },
  gpu: [],
  host: { hostname: os.hostname() },
  updatedAt: Date.now()
};

const clients = new Set();
const rxNormalize = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const rxGpuHash = /hashrate:\s*([\d.]+)\s*kH\/s/i;
const rxTotalHash = /total hashrate:\s*([\d.]+)\s*kH\/s/i;
const rxDifficulty = /difficulty(?:\s*(?:set|is))?\s*(?:to|:)?\s*([\d.]+)/i;
const rxAccepted = /accepted:\s*(\d+)\s*\/\s*(\d+)\s*\(([\d.]+)%\)/i;
const rxRejected = /rejected(?:\s*:\s*|\s+)(\d+)/i;
const rxInvalid = /invalid(?:\s*:\s*|\s+)(\d+)/i;
const argsSmi = ["--query-gpu=name,temperature.gpu,power.draw,utilization.gpu,clocks.gr,clocks.mem,memory.used,memory.total,pstate", "--format=csv,noheader,nounits"];

let gpuPollTimer = null;
let isGpuPolling = false;
let minerProcess = null;

const safeNum = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const parseMinerLine = rawLine => {
  const line = String(rawLine).replace(rxNormalize, "").trim();
  if (!line) return;
  state.miner.lastLine = line;
  state.updatedAt = Date.now();
  
  const lc = line.toLowerCase();
  
  if (lc.includes("hashrate:")) {
    const m = line.match(rxGpuHash) || line.match(rxTotalHash);
    if (m) state.mining.hashrateKHs = safeNum(m[1]);
  }
  
  if (lc.includes("difficulty")) {
    const m = line.match(rxDifficulty);
    if (m) state.mining.difficulty = safeNum(m[1]);
  }
  
  if (lc.includes("accepted:")) {
    const m = line.match(rxAccepted);
    if (m) {
      state.mining.accepted = Number(m[1]);
      state.mining.submitted = Number(m[2]);
      state.mining.status = "MINING";
      state.mining.lastAcceptedAt = Date.now();
    }
  }
  
  if (lc.includes("rejected")) {
    const m = line.match(rxRejected);
    if (m) state.mining.rejected = Math.max(state.mining.rejected, Number(m[1]));
  }
  
  if (lc.includes("invalid")) {
    const m = line.match(rxInvalid);
    if (m) state.mining.invalid = Math.max(state.mining.invalid, Number(m[1]));
  }
  
  if (lc.includes("error") || lc.includes("failed") || lc.includes("cuda") || lc.includes("not responding") || lc.includes("fatal")) {
    state.miner.lastError = line;
    state.mining.status = "ERROR";
  } else if (lc.includes("stratum") && lc.includes("connect")) {
    if (state.mining.status !== "ERROR") state.mining.status = "CONNECTED";
  } else if (lc.includes("waiting") || lc.includes("paused") || lc.includes("no work")) {
    if (state.mining.status !== "ERROR") state.mining.status = "WAITING";
  }
  
  process.stdout.write(rawLine.endsWith("\n") ? rawLine : rawLine + "\n");
};

const parseNvidiaCsv = out => {
  const lines = String(out).split(/\r?\n/);
  const arr = [];
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    const p = s.split(",");
    arr.push({
      index: i,
      name: (p[0] || "").trim() || `GPU ${i}`,
      temperatureC: safeNum(p[1]),
      powerW: safeNum(p[2]),
      utilizationPct: safeNum(p[3]),
      coreMHz: safeNum(p[4]),
      memoryMHz: safeNum(p[5]),
      memoryUsedMB: safeNum(p[6]),
      memoryTotalMB: safeNum(p[7]),
      pstate: (p[8] || "").trim() || null
    });
  }
  return arr;
};

const pollGpu = () => {
  if (clients.size === 0) {
    manageGpuPolling();
    return;
  }
  if (isGpuPolling) return;
  isGpuPolling = true;
  execFile("nvidia-smi.exe", argsSmi, { windowsHide: true, timeout: 1500 }, (err, stdout) => {
    isGpuPolling = false;
    if (!err && stdout) {
      state.gpu = parseNvidiaCsv(stdout);
      state.updatedAt = Date.now();
      broadcast();
    }
  });
};

const manageGpuPolling = () => {
  if (clients.size > 0 && !gpuPollTimer) {
    pollGpu();
    gpuPollTimer = setInterval(pollGpu, POLL_MS);
  } else if (clients.size === 0 && gpuPollTimer) {
    clearInterval(gpuPollTimer);
    gpuPollTimer = null;
    isGpuPolling = false;
  }
};

const broadcast = () => {
  if (clients.size === 0) return;
  const data = JSON.stringify({
    now: Date.now(),
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000)),
    acceptedRatio: state.mining.submitted > 0 ? (state.mining.accepted / state.mining.submitted) * 100 : null,
    ...state
  });
  const payload = `event: stats\ndata: ${data}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
      manageGpuPolling();
    }
  }
};

const startMiner = () => {
  if (!MINER_ARGS || MINER_ARGS.length === 0) {
    const msg = "MINER_ARGS is not configured. Please define MINER_ARGS in your .env file.";
    console.warn(`[dashboard] Warning: ${msg}`);
    state.miner.running = false;
    state.miner.lastError = msg;
    state.mining.status = "STOPPED";
    return;
  }
  console.log(`[dashboard] Starting ${MINER_EXE}`);
  minerProcess = spawn(MINER_EXE, MINER_ARGS, { cwd: MINER_CWD, windowsHide: false, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  state.miner.running = true;
  state.miner.exitCode = null;
  state.miner.signal = null;
  state.mining.status = "STARTING";
  let stdoutBuf = "", stderrBuf = "";
  
  const handle = (chunk, isOut) => {
    let buf = (isOut ? stdoutBuf : stderrBuf) + String(chunk);
    let idx = buf.lastIndexOf('\n');
    if (idx !== -1) {
      const lines = buf.slice(0, idx).split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) parseMinerLine(lines[i] + "\n");
      }
      buf = buf.slice(idx + 1);
      if (clients.size > 0) broadcast();
    }
    if (isOut) stdoutBuf = buf;
    else stderrBuf = buf;
  };
  
  minerProcess.stdout.on("data", d => handle(d, true));
  minerProcess.stderr.on("data", d => handle(d, false));
  
  minerProcess.on("error", err => {
    state.miner.running = false;
    state.miner.lastError = `Miner process error: ${err.message}`;
    state.mining.status = "ERROR";
    state.updatedAt = Date.now();
    if (clients.size > 0) broadcast();
  });
  
  minerProcess.on("close", (code, sig) => {
    if (stdoutBuf) parseMinerLine(stdoutBuf);
    if (stderrBuf) parseMinerLine(stderrBuf);
    state.miner.running = false;
    state.miner.exitCode = code;
    state.miner.signal = sig;
    state.mining.status = "STOPPED";
    state.updatedAt = Date.now();
    minerProcess = null;
    if (clients.size > 0) broadcast();
  });
};

const INDEX_HTML_BUFFER = Buffer.from(INDEX_HTML, "utf8");

const startServer = () => {
  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (DASHBOARD_TOKEN) {
      if (parsedUrl.searchParams.get("token") !== DASHBOARD_TOKEN) {
        res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Unauthorized");
      }
    }
    const path = parsedUrl.pathname;
    if (path === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({
        now: Date.now(),
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000)),
        acceptedRatio: state.mining.submitted > 0 ? (state.mining.accepted / state.mining.submitted) * 100 : null,
        ...state
      }));
    }
    if (path === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
      clients.add(res);
      manageGpuPolling();
      broadcast();
      const hb = setInterval(() => {
        try { res.write(": hb\n\n"); } catch { clearInterval(hb); clients.delete(res); manageGpuPolling(); }
      }, 15000);
      req.on("close", () => { clearInterval(hb); clients.delete(res); manageGpuPolling(); });
      return;
    }
    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("ok");
    }
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { 
        "Content-Type": "text/html; charset=utf-8", 
        "Content-Length": INDEX_HTML_BUFFER.length,
        "Cache-Control": "no-store" 
      });
      return res.end(INDEX_HTML_BUFFER);
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });
  
  server.listen(PORT, HOST, () => {
    let lan = "127.0.0.1";
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry.family === "IPv4" && !entry.internal) lan = entry.address;
      }
    }
    console.log(`[dashboard] http://${HOST}:${PORT}\n[dashboard] LAN: http://${lan}:${PORT}`);
  });

  const cleanExit = () => {
    if (minerProcess && !minerProcess.killed) {
      try { minerProcess.kill(); } catch {}
    }
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", cleanExit);
  process.on("SIGTERM", cleanExit);
};

startMiner();
startServer();
