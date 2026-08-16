# VerthashMiner Dashboard

> Zero-overhead real-time web monitor & GPU telemetry for VerthashMiner (Vertcoin / VTC)

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://britto.is-a.dev)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)](https://britto.is-a.dev)
[![GPU](https://img.shields.io/badge/GPU-NVIDIA%20CUDA-76B900?logo=nvidia&logoColor=white)](https://britto.is-a.dev)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](https://britto.is-a.dev)

Web monitor dashboard for the [VerthashMiner](https://github.com/CryptoGraphics/VerthashMiner).

A lightweight, zero-overhead Windows dashboard that acts as a wrapper around VerthashMiner to provide a beautiful web-based UI with live GPU telemetry.

## Compatibility & Requirements

- **CUDA Devices Only**: This dashboard relies on `nvidia-smi` for GPU telemetry and currently only supports NVIDIA/CUDA devices.
- **NVIDIA Drivers**: Ensure your NVIDIA graphics drivers are properly installed and `nvidia-smi` is available in your system PATH.
- **Windows Only**: Designed and tested specifically for Windows environments.
- **Node.js**: Requires Node.js installed and available as `node` in CMD. No `npm install` dependencies are required!
- **VerthashMiner**: This dashboard is a standalone module. You must download [VerthashMiner](https://github.com/CryptoGraphics/VerthashMiner) separately and place this dashboard folder in the same directory (or configure the path).

## What it does

- Starts VerthashMiner directly from Node.js.
- Reads the miner's stdout/stderr without changing its mining arguments.
- Polls `nvidia-smi` efficiently _only_ when the dashboard is open, at a hard-clamped interval of 3–10 seconds (default 5s). Refresh and reconnect cannot spawn extra polls.
- Serves a premium glassmorphism-based web dashboard over HTTP.
- Uses Server-Sent Events (SSE) for live updates.
- 100% zero-overhead background operation (uses virtually 0% CPU/GPU when the browser tab is closed).

## Setup & Configuration

### 1. Clone the Repository

Clone this repository directly into your VerthashMiner directory (or any preferred location):

```bash
git clone https://github.com/brittojo7n/VerthashMiner-Dashboard.git
cd VerthashMiner-Dashboard
```

### 2. Create your `.env`

Copy `.env.example` to `.env` and configure your settings:

**Example:**

```env
PORT=3000
HOST=127.0.0.1
GPU_POLL_MS=5000
MAX_LOGS=50
PASSPHRASE=abc123
SESSION_SECRET=your_random_64_character_hex_string
MINER_EXE=VerthashMiner.exe
MINER_CWD=C:\Mining\VerthashMiner
MINER_ARGS=-u vtc1qwddxt3rmwx00ev9yg4qcwpxnguw5zm7mwej2xk -p c=VTC -o stratum+tcp://verthash.sea.mine.zpool.ca:6144 --verthash-data ..\Vertcoin\Vertcoin\verthash.dat --all-cu-devices
```

### 3. Configure Paths and Arguments

- **`MINER_CWD`**: This is the working directory where `VerthashMiner.exe` is located (e.g. `C:\Mining\VerthashMiner`). It must be set so the dashboard can find the executable and the `verthash.dat` file properly.
- **`MINER_ARGS`**: This variable determines how the dashboard launches the miner. You must supply your wallet address, pool, and path to the `verthash.dat` file exactly as you would in a normal `.bat` file.
- **`GPU_POLL_MS`**: How often (in milliseconds) the dashboard queries `nvidia-smi` while a dashboard tab is open. **Default is `5000`**. Allowed range is **`3000`–`10000`** (3–10 seconds). Values outside this range are clamped. Polling is globally rate-limited: page refresh, tab reconnect, or multiple clients cannot trigger `nvidia-smi` more often than this interval. The last cached GPU telemetry is sent immediately on refresh so the UI does not go blank.
- **`MAX_LOGS`**: Sets the maximum number of console logs to hold in memory and display on the dashboard (default is 50, minimum is 15, maximum is 500).
- **`FORWARD_CONSOLE`**: When set to `true`, forwards the miner's stdout/stderr directly to the dashboard's terminal for local debugging. **Defaults to `false`** — when disabled, there is zero CPU or memory overhead from console forwarding. Only enable this if you need to watch miner logs locally without using the web UI.

#### Security & Authentication
- **`SESSION_SECRET`**: **(Required)** A cryptographic secret used to sign secure cookies. You must provide a strong, random string (e.g., a 64-character hex string) to prevent the dashboard from crashing on startup.
- **`PASSPHRASE`**: **(Required if exposed to LAN)** The password used to unlock the dashboard web UI. **Important:** If your `HOST` is configured to `0.0.0.0` or any non-local IP (exposing the dashboard to your local network), you are **strictly required** to set a `PASSPHRASE`. If you fail to do so, the backend will intentionally crash on startup to protect your miner from unauthorized network access.

_Make sure to include `--all-cu-devices` in `MINER_ARGS` since this dashboard tracks NVIDIA GPUs!_

### 4. Running the Dashboard

Put the entire folder (`VerthashMiner-Dashboard`) right where the folder for `VerthashMiner` is situated, and then create the following batch file outside both folders (name it anything you like, such as `launch.bat` or `start.bat`):

```bat
@echo off
setlocal

net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

node ".\VerthashMiner-Dashboard\server.js"
pause
```

Now you can just double click your batch file to spin up both the miner and dashboard simultaneously!

_(Alternatively, you can open CMD directly inside the dashboard folder and run `node server.js`)_

### 5. Access the Dashboard

- Local access (default): `http://127.0.0.1:3000`
- **Remote access**: To access the dashboard from another device on your LAN (e.g. `http://HOST:PORT`), you must edit your `.env` file and change `HOST=127.0.0.1` to `HOST=0.0.0.0` and restart the dashboard.

## Windows Firewall

If another device cannot connect, Windows Firewall may be blocking TCP 3000.
Create a narrowly scoped inbound rule for TCP 3000 on the Private profile. Do not expose this port directly to the public internet.

## API

- JSON status: `GET /api/status`
- Live stream: `GET /events`
- Health check: `GET /health`

## Project structure

No build step and no runtime dependencies: `node server.js` is the only command.
The browser loads native ES modules directly.

```
server.js              orchestrator; wires the modules together
src/
  config.js            .env parsing, validation and fail-fast security gates
  constants.js         shared status/log/limit enums
  state.js             central state object and the client snapshot projection
  parser.js            classifies VerthashMiner log lines
  devices.js           --device-list parsing, PCI normalisation, stream reader
  miner.js             child-process supervision and lifecycle actions
  gpu.js               nvidia-smi polling (only while a client is attached)
  sse.js               Server-Sent Events fan-out
  http.js              routing
  auth.js              sessions, lockout, constant-time comparison
  ratelimit.js         fixed-window limiter with Retry-After support
  static.js            in-memory asset cache
public/
  index.html
  style.css
  js/
    app.js             entry point and render loop
    connection.js      SSE lifecycle, backoff, rate-limit recovery
    gpu.js             GPU telemetry cards
    console.js         miner console
    toast.js           notifications
    dom.js             cached lookups and change-guarded writes
    format.js          pure formatting helpers
```

## Tests

```bash
./test/all.sh          # everything
node test/run.js       # server modules
node test/client.mjs   # browser modules against a DOM stub
node test/render.mjs   # full render pass using a captured snapshot
```

The suites are dependency-free. `test/snapshot.json` is a real `/api/status`
payload, so the render test fails if the UI stops populating.

## Performance notes

Measured with a tab open and the miner streaming:

- **Idle CPU (no tab open): 0.00000%** — no timers, no polling, no parsing.
- **Active CPU: ~0.13%**, dominated by the `nvidia-smi` spawn.
- **RSS: ~55 MB**, of which roughly 40 MB is the Node runtime itself; the
  application accounts for a few MB. A lower total is not reachable on Node
  regardless of application code.

The zero-idle property is structural and must be preserved: GPU polling and log
parsing are both gated on there being at least one SSE subscriber, and the
client closes its stream when the tab is hidden.
