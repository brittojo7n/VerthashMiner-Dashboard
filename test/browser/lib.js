"use strict";
/* Shared plumbing for the browser harness: chromium launch + dashboard server boot. */
const path = require("node:path");
const fs = require("node:fs");
const { execSync } = require("node:child_process");
const { Server } = require("../../server.js");
const { buildConfig } = require("../../src/config.js");

const ROOT = path.join(__dirname, "..", "..");
const MOCK_MINER = path.join(ROOT, "test", "mocks", "miner");
const MOCK_SMI_DIR = path.join(ROOT, "test", "mocks", "bin");

process.env.PATH = `${MOCK_SMI_DIR}:${process.env.PATH}`;

async function launchBrowser(puppeteer, { viewport = { width: 800, height: 1280 } } = {}) {
  const chromium = require("@sparticuz/chromium").default;
  const executablePath = await chromium.executablePath();
  const args = chromium.args.filter(a => a !== "--single-process");
  return puppeteer.launch({
    args: [...args, "--no-sandbox", "--font-render-hinting=none"],
    executablePath,
    headless: "shell",
    env: { ...process.env, LD_LIBRARY_PATH: "/tmp/al2023/lib" },
    defaultViewport: { ...viewport, deviceScaleFactor: 1 }
  });
}

/* Extract the pre-change client (HEAD commit) into /tmp for A/B comparison. */
function oldPublicDir() {
  const dir = "/tmp/vmd-old-public";
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execSync(`git -C "${ROOT}" archive HEAD public | tar -x -C "${dir}" --strip-components=1`, { stdio: "pipe" });
  return dir;
}

async function bootServer({ minerEnv = {}, smiMode = "ok", publicDir, freezeTime = false } = {}) {
  for (const k of Object.keys(process.env)) if (k.startsWith("MOCK_")) delete process.env[k];
  process.env.MOCK_SMI_MODE = smiMode;
  for (const [k, v] of Object.entries(minerEnv)) process.env[k] = String(v);
  if (freezeTime) {
    const FIXED = 1755710000000;
    const RealDate = Date;
    global.Date = class extends RealDate {
      constructor(...args) { if (args.length === 0) super(FIXED); else super(...args); }
      static now() { return FIXED; }
    };
  }
  const config = buildConfig({
    PORT: "0", HOST: "127.0.0.1", SESSION_SECRET: "browser-harness-" + "k".repeat(50),
    GPU_POLL_MS: "3000",
    MINER_EXE: MOCK_MINER, MINER_CWD: ROOT,
    MINER_ARGS: "-u VkcBrowserTest.rig --all-cu-devices"
  });
  const server = new Server({ config, publicDir });
  server.start();
  await new Promise(r => server.httpServer.once("listening", r));
  return { server, port: server.httpServer.address().port };
}

async function stopServer(booted) {
  const { server } = booted;
  try {
    await server.minerManager.stop();
    server.minerManager.dispose();
    server.gpuManager.stop();
    server.sseHub.closeAll();
    if (typeof server.httpServer.closeAllConnections === "function") server.httpServer.closeAllConnections();
    await new Promise(r => server.httpServer.close(() => r()));
  } catch { }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { launchBrowser, bootServer, stopServer, oldPublicDir, sleep, ROOT };
