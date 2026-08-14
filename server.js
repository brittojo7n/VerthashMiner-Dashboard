const http = require("node:http");
const { spawn, execFile } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m) process.env[m[1]] = (m[2] || "").replace(/^["']|["']$/g, "").trim();
  }
} catch {}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const POLL_MS = Number(process.env.GPU_POLL_MS || 2000);
const MAX_LOGS = Math.min(500, Math.max(15, Number(process.env.MAX_LOGS || 50)));
const MINER_EXE = process.env.MINER_EXE || "VerthashMiner.exe";
const MINER_ARGS = (process.env.MINER_ARGS || "").match(/"([^"]*)"|(\S+)/g)?.map(m => m.replace(/^"|"$/g, "")) || [];
const MINER_CWD = process.env.MINER_CWD || "";
const TOKEN = process.env.DASHBOARD_TOKEN || "";

class CircularLogBuffer {
  constructor(cap) {
    this.capacity = cap;
    this.buf = new Array(cap);
    this.head = 0;
    this.count = 0;
    this.seq = 0;
  }
  push(text, type = "info") {
    const d = new Date();
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
    this.buf[this.head] = { id: ++this.seq, time, text, type };
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }
  toJSON() {
    return this.count < this.capacity
      ? this.buf.slice(0, this.count)
      : this.buf.slice(this.head).concat(this.buf.slice(0, this.head));
  }
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const staticFiles = {};
const loadStatic = (rel, uri) => {
  try {
    const buf = fs.readFileSync(path.join(__dirname, "public", rel));
    staticFiles[uri] = { buf, type: MIME[path.extname(rel)] || "application/octet-stream" };
  } catch {}
};
loadStatic("index.html", "/");
loadStatic("index.html", "/index.html");
loadStatic("style.css", "/style.css");

const logs = new CircularLogBuffer(MAX_LOGS);
const state = {
  startedAt: Date.now(),
  miner: { running: false, exitCode: null, signal: null, lastLine: "", lastError: "", logs },
  mining: { hashrateKHs: null, accepted: 0, submitted: 0, rejected: 0, invalid: 0, difficulty: null, status: "STARTING", lastAcceptedAt: null },
  gpu: [],
  host: { hostname: os.hostname() }
};

const clients = new Set();
const rxNorm = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const rxHash = /(?:total )?hashrate:\s*([\d.]+)\s*kH\/s/i;
const rxDiff = /difficulty(?:\s*(?:set|is))?\s*(?:to|:)?\s*([\d.]+)/i;
const rxAcc = /accepted:\s*(\d+)\s*\/\s*(\d+)/i;
const rxStale = /\bstale\s+work\b/i;
const rxErr = /\b(?:\[error\]|\[fatal\]|error:|fatal:|cuda\s+error|out\s+of\s+memory|failed\s+to|connection\s+refused|connection\s+failed|enoent|exception)\b/i;
const rxNonZeroErr = /\b(?:errors?|err):\s*[1-9]\d*\b/i;
const rxZeroErr = /\b(?:errors?|err):\s*0\b/i;
const rxWarn = /\b(?:\[warn(?:ing)?\]|warning:|warn:|\bwarnings?:\s*[1-9]\d*)\b/i;
const rxSuccess = /\b(?:accepted:\s*\d+\s*\/\s*\d+|share\s+accepted|loaded\s+succes|verified\s+succes|successfully\s+configured)\b/i;
const smiArgs = ["--query-gpu=name,temperature.gpu,power.draw,utilization.gpu,clocks.gr,clocks.mem,memory.used,memory.total,pstate", "--format=csv,noheader,nounits"];

const matchNum = (str, rx, idx = 1) => {
  const m = str.match(rx);
  return m ? Number(m[idx]) : null;
};

const pushLog = (raw, type = "info") => {
  const line = String(raw).replace(rxNorm, "").trim();
  if (line) {
    logs.push(line, type);
    state.miner.lastLine = line;
  }
};

const classifyLine = (line, lc) => {
  const isErr = rxNonZeroErr.test(line) || (rxErr.test(line) && (!rxZeroErr.test(line) || /\b(?:cuda\s+error|failed\s+to|fatal|exception|enoent)\b/i.test(line)));
  const isWarn = !isErr && rxWarn.test(line) && !/\bwarnings?:\s*0\b/i.test(line);
  return {
    isErr,
    type: isErr ? "error" : isWarn ? "warn" : rxSuccess.test(line) ? "success" : (lc.includes("stratum") || lc.includes("difficulty") || lc.includes("hashrate:") || lc.includes("device")) ? "accent" : "info"
  };
};

let bcastTimer = null;
const broadcast = () => {
  if (!clients.size || bcastTimer) return;
  bcastTimer = setImmediate(() => {
    bcastTimer = null;
    if (!clients.size) return;
    const payload = `event: stats\ndata: ${JSON.stringify({
      now: Date.now(),
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000)),
      acceptedRatio: state.mining.submitted > 0 ? (state.mining.accepted / state.mining.submitted) * 100 : null,
      ...state
    })}\n\n`;
    for (const res of clients) {
      try { res.write(payload); }
      catch { clients.delete(res); manageGpu(); }
    }
  });
};

const parseMinerLine = raw => {
  const line = String(raw).replace(rxNorm, "").trim();
  if (!line) return;
  const lc = line.toLowerCase();
  const { isErr, type } = classifyLine(line, lc);

  if (isErr) {
    state.miner.lastError = line;
    state.mining.status = "ERROR";
  }
  pushLog(line, type);

  const hr = matchNum(line, rxHash);
  if (hr != null) {
    state.mining.hashrateKHs = hr;
    if (hr > 0) {
      state.mining.status = "MINING";
      if (!isErr) state.miner.lastError = "";
    }
  }

  const diff = matchNum(line, rxDiff);
  if (diff != null) state.mining.difficulty = diff;

  const acc = line.match(rxAcc);
  if (acc) {
    state.mining.accepted = Number(acc[1]);
    state.mining.submitted = Number(acc[2]);
    state.mining.rejected = Math.max(0, state.mining.submitted - state.mining.accepted);
    state.mining.status = "MINING";
    state.mining.lastAcceptedAt = Date.now();
    state.miner.lastError = "";
  }

  if (rxStale.test(line)) state.mining.invalid++;

  if (!isErr && state.mining.status !== "MINING") {
    if (lc.includes("stratum") && lc.includes("connect")) state.mining.status = "CONNECTED";
    else if (lc.includes("waiting") || lc.includes("paused") || lc.includes("no work")) state.mining.status = "WAITING";
  }

  process.stdout.write(raw.endsWith("\n") ? raw : raw + "\n");
};

let gpuTimer = null, isGpu = false;
const pollGpu = () => {
  if (!clients.size || isGpu) return;
  isGpu = true;
  execFile("nvidia-smi.exe", smiArgs, { windowsHide: true, timeout: 1500 }, (err, out) => {
    isGpu = false;
    if (!err && out) {
      state.gpu = String(out).trim().split(/\r?\n/).map((s, i) => {
        const p = s.split(",");
        return {
          index: i,
          name: (p[0] || "").trim() || `GPU ${i}`,
          temperatureC: Number(p[1]) || null,
          powerW: Number(p[2]) || null,
          utilizationPct: Number(p[3]) || null,
          coreMHz: Number(p[4]) || null,
          memoryMHz: Number(p[5]) || null,
          memoryUsedMB: Number(p[6]) || null,
          memoryTotalMB: Number(p[7]) || null,
          pstate: (p[8] || "").trim() || null
        };
      });
      broadcast();
    }
  });
};

const manageGpu = () => {
  if (clients.size > 0 && !gpuTimer) {
    pollGpu();
    gpuTimer = setInterval(pollGpu, POLL_MS);
  } else if (clients.size === 0 && gpuTimer) {
    clearInterval(gpuTimer);
    gpuTimer = null;
    isGpu = false;
  }
};

let minerProc = null;
const startMiner = () => {
  if (!MINER_CWD || !MINER_ARGS.length) {
    const msg = !MINER_CWD ? "MINER_CWD not configured in .env" : "MINER_ARGS not configured in .env";
    state.miner.lastError = msg;
    state.mining.status = "STOPPED";
    pushLog(msg, "warn");
    return;
  }
  pushLog(`Starting: ${MINER_EXE} ${MINER_ARGS.join(" ")}`, "info");
  minerProc = spawn(MINER_EXE, MINER_ARGS, { cwd: MINER_CWD, windowsHide: false, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  state.miner.running = true;
  state.mining.status = "STARTING";

  const createStreamReader = () => {
    let buf = "";
    return chunk => {
      buf += String(chunk);
      const idx = buf.lastIndexOf("\n");
      if (idx !== -1) {
        for (const l of buf.slice(0, idx).split(/\r?\n/)) if (l) parseMinerLine(l + "\n");
        buf = buf.slice(idx + 1);
        broadcast();
      }
    };
  };

  minerProc.stdout.on("data", createStreamReader());
  minerProc.stderr.on("data", createStreamReader());
  minerProc.on("error", err => {
    state.miner.running = false;
    state.miner.lastError = err.message;
    state.mining.status = "ERROR";
    pushLog(err.message, "error");
    broadcast();
  });
  minerProc.on("close", (code, sig) => {
    state.miner.running = false;
    state.miner.exitCode = code;
    state.mining.status = "STOPPED";
    pushLog(`Exited (code: ${code}${sig ? `, sig: ${sig}` : ""})`, code === 0 ? "info" : "warn");
    minerProc = null;
    broadcast();
  });
};

const send = (res, status, type, body, len) => {
  const headers = { "Content-Type": type, "Cache-Control": "no-store" };
  if (len !== undefined) headers["Content-Length"] = len;
  res.writeHead(status, headers);
  res.end(body);
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (TOKEN && u.searchParams.get("token") !== TOKEN) return send(res, 401, "text/plain", "Unauthorized");

  const p = u.pathname;
  if (p === "/api/status") {
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify({
      now: Date.now(),
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000)),
      acceptedRatio: state.mining.submitted > 0 ? (state.mining.accepted / state.mining.submitted) * 100 : null,
      ...state
    }));
  }
  if (p === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    clients.add(res);
    manageGpu();
    broadcast();
    const hb = setInterval(() => {
      try { res.write(": hb\n\n"); }
      catch { clearInterval(hb); clients.delete(res); manageGpu(); }
    }, 15000);
    req.on("close", () => { clearInterval(hb); clients.delete(res); manageGpu(); });
    return;
  }
  if (p === "/health") return send(res, 200, "text/plain", "ok");
  
  const staticFile = staticFiles[p];
  if (staticFile) return send(res, 200, staticFile.type, staticFile.buf, staticFile.buf.length);

  send(res, 404, "text/plain", "Not found");
});

server.listen(PORT, HOST, () => {
  let lan = "127.0.0.1";
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const e of entries || []) if (e.family === "IPv4" && !e.internal) lan = e.address;
  }
  console.log(`[dashboard] http://${HOST}:${PORT}\n[dashboard] LAN: http://${lan}:${PORT}`);
});

const cleanExit = () => {
  if (minerProc && !minerProc.killed) try { minerProc.kill(); } catch {}
  process.exit(0);
};
process.on("SIGINT", cleanExit);
process.on("SIGTERM", cleanExit);

startMiner();
