# VerthashMiner Dashboard

Lightweight web dashboard for VerthashMiner. Launches the miner, streams live logs, and shows GPU telemetry.

## Prerequisites

- Windows with NVIDIA GPUs and `nvidia-smi` on PATH
- Node.js 18+ available as `node`
- VerthashMiner downloaded separately
- `verthash.dat` placed in the miner folder

## Setup

- Download VerthashMiner, follow its instructions to generate the verthash data file (`verthash.dat`), if you haven't done yet.
- Place this repository folder next to the VerthashMiner folder.
- Create your `.env` by copying the example file:

  ```powershell
  Copy-Item -Path ".env.example" -Destination ".env"
  ```

  ```bat
  copy .env.example .env
  ```

- Open `.env` in a text editor and fill in your values. All available options are documented in `.env.example`.

## Environment Variables

The dashboard uses a `.env` file (or OS environment variables) for configuration. In addition to the required miner arguments, you can set the following optional flags:

- **`FORWARD_CONSOLE=true`**: Mirrors the VerthashMiner stdout/stderr directly to the local CLI/terminal where `main.js` is running. This runs unconditionally, allowing you to monitor the raw miner output in your terminal regardless of whether any browser tabs are open. This value is parsed case-insensitively (e.g. `True`, `true`).

## Start

```bat
node main.js
```

Open `http://127.0.0.1:4067` (or your LAN IP if you had given `0.0.0.0` as the IP) and enter the passphrase (if you have set one).

## Project structure

```plain
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

`nvidia-smi` is only queried (read-only) while a browser tab is open.

Optional lean launch (saves ~6 MB RSS):

```bat
set UV_THREADPOOL_SIZE=2
node --jitless --max-semi-space-size=4 --max-old-space-size=32 main.js
```
