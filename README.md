# VerthashMiner Dashboard

Lightweight web dashboard for VerthashMiner. Launches the miner, streams live logs, and shows GPU telemetry.

## Prerequisites

- Windows with NVIDIA GPUs and `nvidia-smi` on PATH
- Node.js 18+ available as `node`
- VerthashMiner downloaded separately
- `verthash.dat` placed in the miner folder

## Setup

1. Place this dashboard folder next to your miner folder.
2. Create a `.env` file in the dashboard root:

```env
PORT=4067
HOST=0.0.0.0
PASSPHRASE=your-secret-passphrase
SESSION_SECRET=your_random_64_character_hex_string
MINER_CWD=miner
MINER_ARGS=-u vtc1qwddxt3rmwx00ev9yg4qcwpxnguw5zm7mwej2xk -p c=VTC -o stratum+tcp://pool.example.com:6144 --verthash-data ..\..\Vertcoin\Vertcoin\verthash.dat --all-cu-devices
```

| Variable | Purpose |
|----------|---------|
| `PORT` | Dashboard port. Default `4067`. |
| `HOST` | Bind address. Use `0.0.0.0` for LAN access, `127.0.0.1` for local only. Non-local binds **require** `PASSPHRASE`. |
| `PASSPHRASE` | Web UI password. Required when `HOST` is non-local. |
| `SESSION_SECRET` | Random string (≥32 chars) used to sign session cookies. Required. |
| `MINER_CWD` | Path to the miner folder (relative or absolute). |
| `MINER_ARGS` | Miner command-line arguments. `--protocol-dump` is appended automatically. Include `--all-cu-devices` (or `--cu-devices 1,3`) so telemetry maps to the correct GPUs. |
| `GPU_POLL_MS` | `nvidia-smi` poll interval in ms. Default `5000`. Clamped to `3000–10000`. |
| `FORWARD_CONSOLE` | `true` mirrors miner output to the launcher terminal. Default `false`. |
| `ENV_FILE` | Optional path to an alternative env file. Real environment variables take precedence. |

## Start

```bat
node main.js
```

Open `http://127.0.0.1:4067` (or your LAN IP) and enter the passphrase.

To stop mining from the dashboard, use the **STOP** button. To start again, use **START**.

## Project structure

```
main.js                   entry point (node main.js)
server/                   Node.js application runtime
  core/                   shared foundations: config, constants, state, timers
  http/                   HTTP subsystem: http, sse, auth, ratelimit, static, bundle
  miner/                  miner process + hardware: miner, parser, devices, gpu
web/                      browser-facing web application
  index.html              document template
  style.css               stylesheet
  favicon.svg             favicon
  core/                   bootstrap + infrastructure: app, head, connection, perf
  components/             UI components: console, gpu, modal, toast
  lib/                    shared utilities: dom, present
```

Delivery follows a three-layer model: the `web/` source is composed at startup into a single bundle and served through an explicit allowlist (`/`, `/index.html`, `/app.js`, `/style.css`, `/favicon.svg`). Internal paths such as `/js/*`, `/server/*`, `/web/*` and any traversal are never resolvable over HTTP.

## Resource footprint

Measured on Node 22 (Linux x86-64, 2 cores): **~0.08% CPU idle**, **~0.2% CPU** with one browser tab streaming. The dashboard's own heap is **~6–8 MB**; the rest of the process RSS is the Node runtime (~41 MB floor), so a plain `node main.js` idles around **54 MB**.

Optional lean launch (saves ~6 MB RSS):

```bat
set UV_THREADPOOL_SIZE=2
node --jitless --max-semi-space-size=4 --max-old-space-size=32 main.js
```

`nvidia-smi` is only queried (read-only) while a browser tab is open.
