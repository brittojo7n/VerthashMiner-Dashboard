# VerthashMiner Dashboard

> Zero-overhead real-time web monitor & GPU telemetry for VerthashMiner (Vertcoin / VTC)

A lightweight, zero-dependency Windows dashboard that wraps
[VerthashMiner](https://github.com/CryptoGraphics/VerthashMiner): it launches the
miner unchanged, classifies its log stream, polls `nvidia-smi` only while a
dashboard tab is open, and serves a glassmorphism UI over Server-Sent Events.
No build step, no npm packages — `node server.js` is the only command.

## Requirements

- Windows rig with NVIDIA/CUDA GPUs and `nvidia-smi` on PATH
- Node.js 18+ available as `node`
- VerthashMiner downloaded separately

## Setup

Place this folder next to your miner folder, then create a `.env` (template
below) in the dashboard root:

```env
PORT=3000
HOST=127.0.0.1
GPU_POLL_MS=5000
FORWARD_CONSOLE=false
PASSPHRASE=your-secret-passphrase
SESSION_SECRET=your_random_64_character_hex_string
MINER_EXE=VerthashMiner.exe
MINER_CWD=..\VerthashMiner
MINER_ARGS=-u your_wallet_address -p c=VTC -o stratum+tcp://your_pool:port --verthash-data path\to\verthash.dat --all-cu-devices
```

| Key | Notes |
|---|---|
| `PORT` / `HOST` | Bind address. Anything non-local **requires** `PASSPHRASE` or startup fails closed. |
| `GPU_POLL_MS` | `nvidia-smi` interval, hard-clamped to 3000–10000 ms. Refreshes and extra clients cannot amplify spawns. |
| `MINER_CWD` / `MINER_EXE` | Working directory and executable of the miner. |
| `MINER_ARGS` | Passed through verbatim; `--protocol-dump` is appended automatically. Include `--all-cu-devices` (or `--cu-devices 1,3`) so hashrates map onto the right cards. |
| `PASSPHRASE` | Web UI password. Sessions are HMAC cookies with sliding 30-minute expiry; brute force is throttled with lockout. |
| `SESSION_SECRET` | Required; signs session cookies. Use ≥32 random characters. |
| `FORWARD_CONSOLE` | `true` mirrors miner stdout/stderr into the launcher terminal. Default `false` (zero overhead). |
| `ENV_FILE` | Point at an alternative env file; real environment variables always win. |

Launch (run as Administrator so the miner can reset GPU clocks):

```bat
@echo off
node "%~dp0server.js"
pause
```

Access at `http://127.0.0.1:3000`. For LAN access set `HOST=0.0.0.0` and open a
narrow firewall rule for `PORT` on the Private profile; never expose it to the
internet. On Windows the dashboard drops itself to below-normal priority and
restores the miner to normal.

## Resource envelope

Measured on the reference rig (miner streaming ~85 log lines/min, one dashboard
tab attached, 5 s telemetry interval):

| Metric | Standard launch | Minimum-footprint launch |
|---|---|---|
| CPU, idle (no tab open) | 0.02–0.10% | 0.07% |
| CPU, active (tab open, live stream) | 0.08–0.13% | **0.083%** |
| Application heap in use | 5.5 MB idle / 7.6 MB active | flat over 60 s soak |
| Process RSS | ~54 MB | **~48 MB** |

Minimum-footprint launch:

```bat
set UV_THREADPOOL_SIZE=2
node --max-semi-space-size=4 --max-old-space-size=32 --jitless "%~dp0server.js"
```

`--jitless` removes V8's JIT code pages (−6 MB) and is safe here: the server
uses only `node:http`, `child_process`, `crypto` and `zlib`, never WebAssembly
or `fetch`. Its per-line parsing budget is microseconds, far below any real log
rate. A blank `node -e ""` process alone occupies ~41 MB, so total process RSS
can never reach 20 MB on Node.js — the application itself stays under 8 MB.

## Architecture

One-way data flow; the browser tab is the on/off switch for all server work:

```
server.js
  |- config.js      .env parsing, fail-fast security gates
  |- miner.js       child-process supervision (probes --device-list for PCI map)
  |- parser.js      log classification -> single state object
  |- gpu.js         nvidia-smi polling, gated on subscriber count
  |- sse.js         coalesced fan-out, incremental console frames, heartbeat
  |- http.js        routing, sessions, rate limiting, gzip/ETag assets
  |- auth.js ratelimit.js static.js state.js devices.js constants.js
        |
   browser: native ES modules, EventSource, no build step
```

Zero-idle guarantees: no `nvidia-smi` spawns, no SSE frames and no timers while
no tab is attached; polling intervals clamped with a global cooldown; failure
backoff on a missing driver; static assets read once at boot, pre-gzipped with
ETag revalidation; the miner's stdout is still parsed while idle (~5 us/line)
so a late-attaching tab sees current counters.

### Log contract

Miner logging arrives on stderr as `[YYYY-MM-DD HH:MM:SS] LEVEL message` with
the level at a fixed offset; only `ERROR`-level lines can change the reported
status, so `DEBUG Failed to get Stratum session id` cannot look like a crash.
Recognised payloads: per-device `cu_device(N):[ err:K,] temp:NC, power:NW,
fan:N%, hashrate: N.NN kH/s` (the inline `err:K` is a memory counter, not a
failure; `N` is the worker slot, remapped through `--cu-devices` selections),
share lines `accepted: A/B (P%), total hashrate: ...` where rejected = B−A,
difficulty updates (including JSON `mining.set_difficulty` frames), worker
banners `Configured N(CL) and M(CUDA) workers`, and stratum failures
(`connection timed out`, `recv_line failed`, ...) which surface as
`DISCONNECTED` — and stay visible, because healthy hashrate lines alone cannot
clear a pool outage. Rig total is the sum of per-device rates, published only
once every worker has reported. Telemetry rows are joined to hashrates by
normalised PCI bus id (`00000000:01:00.0` ↔ `01:00:0`), falling back to
position.

### Low-end and tablet clients

The page renders in a cheap tier first; the expensive tier (backdrop blur,
deeper shadows, loop animations) must be earned: ≤2 GB devices are locked out,
≥8 GB + ≥8 cores are upgraded instantly, everything else (including 4 GB
tablets, whose reported device memory rounds down to 4) runs a ~0.7 s
compositing probe that must hold 60 fps on a real blurred surface. A runtime
governor then samples actual frame times and demotes to the cheap tier for the
tab session whenever 60 fps cannot be held. Metric updates animate
`transform` only, hidden modals leave the paint tree, and hover paints are
gated to hover-capable pointers. `prefers-reduced-motion` and `update: slow`
devices are locked to the cheap tier permanently. Desktop visuals are
unaffected and pixel-stable.

## API

- `GET /api/status` — full JSON snapshot (polling fallback)
- `GET /events` — SSE; each frame carries only new console lines
  (`logsFrom`/`logSeq`/`logCount`/`logCapacity`); max 4 concurrent viewers,
  resync on missed frames
- `GET /health` — liveness
- `POST /api/login` — requires `X-Requested-With: XMLHttpRequest` + same-origin
- `POST /api/miner/{start|stop|restart}` — same CSRF guard, rate limited

## Project layout

```
server.js          orchestrator
src/               config, state, parser, devices, miner, gpu, sse,
                   http, auth, ratelimit, static, constants
public/            index.html, style.css, favicon.svg, js/ (app, connection,
                   gpu, console, toast, present, perf, dom, head)
```

MIT licensed — see `LICENSE`.
