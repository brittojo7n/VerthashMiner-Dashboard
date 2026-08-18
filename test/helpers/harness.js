"use strict";

const http = require("node:http");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const ROOT = path.resolve(__dirname, "..", "..");
const MOCK_MINER = path.join(ROOT, "test", "mocks", "mock-miner.js");

const { buildConfig } = require(path.join(ROOT, "src", "config"));
const { createState } = require(path.join(ROOT, "src", "state"));
const { SseHub } = require(path.join(ROOT, "src", "sse"));
const { GpuManager } = require(path.join(ROOT, "src", "gpu"));
const { MinerManager } = require(path.join(ROOT, "src", "miner"));
const { createHttpServer } = require(path.join(ROOT, "src", "http"));

/** Builds a config that launches the mock miner instead of the real binary. */
function mockConfig(overrides = {}) {
  const env = {
    PORT: "0",
    HOST: "127.0.0.1",
    SESSION_SECRET: "test-secret-".padEnd(64, "0"),
    // The mock is executable (shebang) so that the `--device-list` probe,
    // which is spawned without MINER_ARGS, also reaches it.
    MINER_EXE: MOCK_MINER,
    MINER_CWD: ROOT,
    MINER_ARGS:
      "-u vtc1qwddxt3rmwx00ev9yg4qcwpxnguw5zm7mwej2xk " +
      "-p c=VTC -o stratum+tcp://verthash.sea.mine.zpool.ca:6144 --all-cu-devices",
    MAX_LOGS: "50",
    ...overrides
  };
  return buildConfig(env, { platform: process.platform });
}

/**
 * Boots the full stack (state + miner + gpu + sse + http) on an ephemeral port
 * with a stubbed nvidia-smi, and returns handles plus a `close()` that leaves
 * no timers, sockets or child processes behind.
 */
async function startServer({ env = {}, smi = null, startMiner = false, mock = {}, timeouts = {} } = {}) {
  // The mock miner is configured through the environment because the
  // `--device-list` probe is spawned without the normal argument list.
  const restoreEnv = [];
  const setEnv = (key, value) => {
    if (value === undefined) return;
    restoreEnv.push([key, process.env[key]]);
    process.env[key] = String(value);
  };
  setEnv("MOCK_MINER_MODE", mock.mode);
  setEnv("MOCK_MINER_INTERVAL_MS", mock.intervalMs);
  setEnv("MOCK_MINER_RATE", mock.rate);
  setEnv("MOCK_MINER_TOTAL", mock.total);

  const config = mockConfig(env);
  const state = createState(config.WALLET, config.MAX_LOGS);

  const sseHub = new SseHub({
    state,
    onSubscriberChange: count => {
      if (count > 0) {
        gpuManager.updateSubscribers(count);
        minerManager.enableParsing();
      } else {
        gpuManager.updateSubscribers(0);
        minerManager.disableParsing();
      }
    }
  });

  const gpuManager = new GpuManager({
    state,
    pollMs: config.GPU_POLL_MS,
    onUpdate: () => sseHub.broadcast(),
    // Default stub: nvidia-smi is "not installed" unless a fake is supplied.
    exec:
      smi ||
      ((_bin, _args, _opts, cb) => {
        setImmediate(() => cb(Object.assign(new Error("spawn nvidia-smi ENOENT"), { code: "ENOENT" })));
      })
  });

  const minerManager = new MinerManager({
    config,
    state,
    onUpdate: () => sseHub.broadcast(),
    timeouts
  });

  const server = createHttpServer({ config, state, sseHub, minerManager });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  if (startMiner) await minerManager.start();

  return {
    config,
    state,
    sseHub,
    gpuManager,
    minerManager,
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      gpuManager.stop();
      sseHub.closeAll();
      await minerManager.stop().catch(() => {});
      minerManager.dispose();
      await new Promise(resolve => {
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        server.close(resolve);
      });
      for (const [key, value] of restoreEnv.reverse()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

/** Minimal promise-based HTTP client (no dependencies, no keep-alive leaks). */
function request(origin, pathname, { method = "GET", headers = {}, body } = {}) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        // Sent verbatim: traversal probes must reach the server unmodified.
        path: pathname,
        method,
        headers: body ? { "Content-Type": "application/json", ...headers } : headers,
        agent: false
      },
      res => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", chunk => (data += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data,
            json() {
              try {
                return JSON.parse(data);
              } catch {
                return null;
              }
            }
          })
        );
      }
    );
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

/**
 * Subscribes to /events and parses the SSE frames.
 * Exposes the raw frames plus helpers to await a matching snapshot.
 */
function sseClient(origin, { headers = {} } = {}) {
  const url = new URL("/events", origin);
  const snapshots = [];
  const waiters = [];
  let buffer = "";
  let res = null;
  let ended = false;

  const emit = snapshot => {
    snapshots.push(snapshot);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(snapshot)) {
        waiters[i].resolve(snapshot);
        waiters.splice(i, 1);
      }
    }
  };

  const ready = new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "GET",
        headers: { Accept: "text/event-stream", ...headers },
        agent: false
      },
      response => {
        res = response;
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`SSE failed with HTTP ${response.statusCode}`));
          return;
        }
        response.setEncoding("utf8");
        response.on("data", chunk => {
          buffer += chunk;
          let sep;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const dataLine = frame.split("\n").find(l => l.startsWith("data: "));
            if (!dataLine) continue;
            try {
              emit(JSON.parse(dataLine.slice(6)));
            } catch {
              /* heartbeat or comment frame */
            }
          }
        });
        response.on("end", () => (ended = true));
        resolve();
      }
    );
    req.on("error", reject);
    req.end();
  });

  return {
    ready,
    snapshots,
    get ended() {
      return ended;
    },
    /** Resolves with the first snapshot matching `predicate`. */
    waitFor(predicate, timeoutMs = 8000) {
      const existing = snapshots.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const entry = { predicate, resolve };
        waiters.push(entry);
        const timer = setTimeout(() => {
          const at = waiters.indexOf(entry);
          if (at !== -1) waiters.splice(at, 1);
          reject(new Error("timed out waiting for snapshot"));
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      });
    },
    close() {
      try {
        res?.destroy();
      } catch {
        /* already closed */
      }
    }
  };
}

/** Replays lines into a state object through the production parser. */
function feed(lines, state, pushLog) {
  const { parseMinerLine } = require(path.join(ROOT, "src", "parser"));
  for (const line of lines) parseMinerLine(line, state, pushLog);
  return state;
}

/** Marks a state as "miner running" so status transitions are allowed. */
function markRunning(state) {
  state.miner.running = true;
  state.miner.startedAt = Date.now();
  state.mining.status = "STARTING";
  return state;
}

module.exports = {
  ROOT,
  MOCK_MINER,
  mockConfig,
  startServer,
  request,
  sseClient,
  feed,
  markRunning,
  delay
};
