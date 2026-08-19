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

Clone this repository into the same parent directory as your `VerthashMiner` folder (or any preferred location):

```bash
git clone https://github.com/brittojo7n/VerthashMiner-Dashboard.git
cd VerthashMiner-Dashboard
```

Your final structure should look like this:

```
<parent_directory>/
  VerthashMiner/
    VerthashMiner.exe
    ...
  VerthashMiner-Dashboard/
    Launch.bat
    server.js
    src/
    public/
    .env.example
```

> `Launch.bat` can live anywhere you want. The example below assumes you place it inside `VerthashMiner-Dashboard/`, but you can also keep it in the parent directory or elsewhere — just adjust the `cd` path accordingly.

### 2. Create your `.env`

Copy `.env.example` to `.env` and configure your settings:

**Example:**

```env
PORT=3000
HOST=127.0.0.1
GPU_POLL_MS=5000
FORWARD_CONSOLE=false
PASSPHRASE=abc123
SESSION_SECRET=your_random_64_character_hex_string
MINER_EXE=VerthashMiner.exe
MINER_CWD=miner
MINER_ARGS=-u your_wallet_address -p c=VTC -o stratum+tcp://your_pool_address:port --verthash-data path\to\verthash.dat --all-cu-devices
```

### 3. Configure Paths and Arguments

- **`MINER_CWD`**: This is the working directory where `VerthashMiner.exe` is located (e.g. `miner` if your structure is `<parent_directory>/miner/`). Relative paths are resolved from the current working directory of the `node` process, not from the dashboard folder. It must be set so the dashboard can find the executable and the `verthash.dat` file properly.
- **`MINER_ARGS`**: This variable determines how the dashboard launches the miner. You must supply your wallet address, pool, and path to the `verthash.dat` file exactly as you would in a normal `.bat` file.
- **`GPU_POLL_MS`**: How often (in milliseconds) the dashboard queries `nvidia-smi` while a dashboard tab is open. **Default is `5000`**. Allowed range is **`3000`–`10000`** (3–10 seconds). Values outside this range are clamped. Polling is globally rate-limited: page refresh, tab reconnect, or multiple clients cannot trigger `nvidia-smi` more often than this interval. The last cached GPU telemetry is sent immediately on refresh so the UI does not go blank.
- **`ENV_FILE`**: Optional. Absolute or relative path to an alternative `.env` file (real environment variables always win over file values).
- **`FORWARD_CONSOLE`**: When set to `true`, forwards the miner's stdout/stderr directly to the dashboard's terminal for local debugging. **Defaults to `false`** — when disabled, there is zero CPU or memory overhead from console forwarding. Only enable this if you need to watch miner logs locally without using the web UI.

#### Console logging behaviour (fixed, not configurable)

- The server always keeps the **50 most recent** miner log lines in memory and replays them to every client that connects, so a fresh tab immediately has context.
- The browser console then behaves like a standard devtools console: it **accumulates a per-tab session history up to 1,000 lines**, pruning the oldest rows past that cap so a tab left open for days never bloats the DOM or memory.
- The session history is cached per tab (`sessionStorage`) and survives in-tab navigation away and back. A **full page refresh starts a clean session**: the console re-seeds from the server's 50 most recent lines and grows again from there.

#### Security & Authentication
- **`SESSION_SECRET`**: **(Required)** A cryptographic secret used to sign secure cookies. You must provide a strong, random string (e.g., a 64-character hex string) to prevent the dashboard from crashing on startup.
- **`PASSPHRASE`**: **(Required if exposed to LAN)** The password used to unlock the dashboard web UI. **Important:** If your `HOST` is configured to `0.0.0.0` or any non-local IP (exposing the dashboard to your local network), you are **strictly required** to set a `PASSPHRASE`. If you fail to do so, the backend will intentionally crash on startup to protect your miner from unauthorized network access.

_Make sure to include `--all-cu-devices` in `MINER_ARGS` since this dashboard tracks NVIDIA GPUs!_

### 4. Running the Dashboard

Create a batch file anywhere you like (for example, in the parent directory next to `VerthashMiner/` and `VerthashMiner-Dashboard/`, or inside `VerthashMiner-Dashboard/` itself).

**If `Launch.bat` is in the parent directory:**

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

**If `Launch.bat` is inside `VerthashMiner-Dashboard/`:**

```bat
@echo off
setlocal

net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

node ".\server.js"
pause
```

Now you can just double click your batch file to spin up both the miner and dashboard simultaneously!

_(Alternatively, you can open CMD directly inside the `VerthashMiner-Dashboard` folder and run `node server.js`)_

### 5. Access the Dashboard

- Local access (default): `http://127.0.0.1:3000`
- **Remote access**: To access the dashboard from another device on your LAN (e.g. `http://HOST:PORT`), you must edit your `.env` file and change `HOST=127.0.0.1` to `HOST=0.0.0.0` and restart the dashboard. Make sure your `PORT` matches what you have configured in `.env`.

## Windows Firewall

If another device cannot connect, Windows Firewall may be blocking the TCP port configured in your `.env` (`PORT`, default `3000`). Create a narrowly scoped inbound rule for that port on the Private profile. Do not expose this port directly to the public internet.

## API

- JSON status: `GET /api/status` — full snapshot (used as the polling fallback)
- Live stream: `GET /events` — SSE; each frame carries only *new* console lines
  (`logsFrom`, `logSeq`, `logCount`, `logCapacity`), and any client that misses a
  frame is transparently resynchronised
- Health check: `GET /health`
- Login: `POST /api/login` — requires `X-Requested-With: XMLHttpRequest` and a
  same-origin `Origin` when one is sent
- Controls: `POST /api/miner/{start|stop|restart}` — same CSRF requirements

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
  favicon.svg
  js/
    app.js             entry point and render loop
    connection.js      SSE lifecycle, backoff, rate-limit recovery
    gpu.js             GPU telemetry cards
    console.js         miner console
    toast.js           notifications
    present.js         pure snapshot -> display-string projection
    perf.js            client capability gate for low-end devices
    dom.js             cached lookups and change-guarded writes
    format.js          pure formatting helpers
```

## Architecture

Data flows one way. The miner's stdout/stderr and `nvidia-smi` mutate a single
state object, which is projected into a JSON snapshot and pushed to the browser
over Server-Sent Events. The only client-to-server traffic is login and three
miner control verbs.

```
server.js
  |- config.js      parses .env, fails fast on insecure configuration
  |- MinerManager   spawns VerthashMiner.exe, reads stdout/stderr
  |     `- probes --device-list first to map PCI id -> CUDA index
  |- parser.js      classifies each line, updates state
  |- GpuManager     polls nvidia-smi only while a client is attached
  |- SseHub         coalesces updates and fans them out
  `- http.js        routing, sessions, rate limiting, static assets
        |
   browser: native ES modules, EventSource, no build step
```

### Zero-idle design

The project's core constraint is that every watt spent on the dashboard is a
watt not spent hashing. Idle cost is kept at zero structurally, not by tuning:

| Mechanism | Effect |
|---|---|
| GPU polling gated on subscriber count | no `nvidia-smi` spawns when nobody is watching |
| Log fan-out gated on subscriber count | no DOM payloads, no SSE frames, no timers while idle |
| Client closes its stream on `visibilitychange` | a hidden tab drops the server to true idle |
| Poll interval clamped to 3-10s with a global cooldown | refresh or extra clients cannot amplify spawns |
| Failure backoff on `nvidia-smi` | a missing driver stops costing a spawn every 5s |
| Incremental console frames | each update ships new lines only, not the whole buffer |
| One shared SSE heartbeat | timer count does not scale with clients |
| Static assets read into memory once at boot | no disk I/O per request |
| `FORWARD_CONSOLE=false` by default | no stdout writes while idle |

Miner output *is* still parsed while idle - that is deliberate. Skipping it would
leave a client that attaches later looking at stale counters, and the measured
cost is 5 us per console line (see below), i.e. far below the noise floor at real
log rates. What is gated is everything that scales: telemetry polling, snapshot
serialisation, and network fan-out.

Any change must preserve this. The browser tab is effectively the on/off switch
for all server-side work.

### GPU attribution

`nvidia-smi` enumeration order and VerthashMiner's CUDA device indices do not
necessarily agree, so hashrates cannot be matched to telemetry positionally.
Both sides report a PCI id in different formats (`00000000:01:00.0` versus
`01:00:0`); these are normalised to a common `bb:dd:f` form and used as the join
key, falling back to positional index when unavailable.

### Miner output

All miner logging goes through one `applog()` call in the upstream source and is
written to **stderr** in the form:

```
[YYYY-MM-DD HH:MM:SS] LEVEL  message
```

with `LEVEL` padded to five characters (`ERROR`, `WARN`, `INFO`, `DEBUG`), which
puts the level at a fixed offset. The level is treated as authoritative: only
`ERROR` lines can change the reported status, so routine output such as
`DEBUG Failed to get Stratum session id` cannot be mistaken for a crash.

| Data | Format |
|---|---|
| Per-device hashrate | `cu_device(N):[ err:N,][ temp:NC,][ power:NW,][ fan:N%,] hashrate: N.NN kH/s` |
| Share result | `accepted: A/B (P%), total hashrate: N.NN kH/s` or `(pending...)` |
| Difficulty | `Stratum difficulty set to N` (may be exponential, e.g. `1e-05`) |
| Device list | `\tIndex: N. Name: ... pcieId: bb:dd:f` |
| Worker banner | `Configured N(CL) and M(CUDA) workers` |

`B` in the share line is `accepted + rejected`, so rejects are `B - A`, and
`total hashrate` is the instantaneous sum of the per-thread rates - which is why
the dashboard sums the per-device lines rather than averaging them. The rig total
is only published once every configured worker has reported at least once, so a
warming-up rig never shows one GPU's rate as the whole machine.

Three details are easy to get wrong:

- the inline `err:N` field is a memory-error counter on an otherwise healthy
  line and must not be treated as a failure;
- stratum disconnects carry no fatal keyword (`Stratum connection timed out`,
  `stratum_recv_line failed`, `Stratum authentication failed`, ...), so they need
  explicit handling or the dashboard keeps reporting `MINING` while the pool is
  gone;
- `cu_device(N)` prints the **worker slot**, not the CUDA device index. They only
  coincide when every device is selected. With `--cu-devices 1,3` the dashboard
  maps worker 0 back to device 1, so telemetry stays attached to the right card.

## Performance notes

Measured on the reference setup: a dashboard tab open, the miner streaming, and
`nvidia-smi` polling at the default 5s interval.

| Metric | Measured |
|---|---|
| Console parsing | **1.5-2.4 us/line** (50 000 lines in 77-119 ms) |
| Idle CPU (miner streaming, no tab open) | **0.02%** — no polling, no fan-out, no timers |
| Active CPU (dashboard open, 85 log lines/min) | **0.13%** over a 3 minute soak |
| RSS | **~56 MB**; application heap is **5.5 MB**, the rest is the Node runtime |
| Heap drift (1 000 lines, 500+ frames) | **0.03 MB** — flat, no leak |
| SSE frame (50-line server buffer) | **~800 B** incremental vs 6.8 KB full replay (8.5x) |
| Cold page load (gzip) | **18.3 KB** for the whole UI, 11 requests |
| Warm page load | **0 B** — every asset revalidates to `304` |
| `nvidia-smi` spawns, 3 clients, 1.5 s | **1** |

The zero-idle property is structural and must be preserved: GPU polling and the
SSE fan-out are gated on there being at least one subscriber, and the client
closes its stream when the tab is hidden.

On Windows the dashboard drops itself to **below-normal process priority** and explicitly
restores the miner to normal, so supervision can never win a CPU contest against hashing.

**GPU usage by the dashboard is zero.** It never links or loads CUDA, OpenCL or
NVML; the only GPU-adjacent call is a read-only `nvidia-smi --query-gpu` that
creates no device context and allocates no VRAM.

## Low-end and tablet clients

The UI is designed to stay smooth on hardware like a Samsung Galaxy Tab E (quad-core A7,
Mali-400, 1.5 GB RAM) without giving up the glassmorphism design:

| Technique | Effect |
|---|---|
| Capability gate (`public/js/perf.js`) | The page renders in a cheap mode first and only enables `backdrop-filter`, large shadows and looping animations after the device proves it can hold ~60 fps. A weak device never paints an expensive frame; a desktop is upgraded within ~200 ms. |
| Layered-gradient glass fallback | Same blue translucent look, zero per-frame GPU cost, no real-time blur |
| No looping animations in cheap mode | The pulse dot and terminal caret stop repainting continuously |
| `prefers-reduced-motion` / `update: slow` | Locked to the cheap mode permanently |
| Console history cap | Per-tab session history tops out at 1,000 rendered rows; the oldest rows are pruned first, so long-lived tabs stay flat on memory |
| Pre-compressed assets + `ETag` | 18.3 KB on a cold load, 0 B on a reload |
| Only the used font weights are requested | No wasted font downloads, no synthesised weights |

Nothing about the visual design changes on a capable machine.
