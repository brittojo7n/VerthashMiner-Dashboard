# VerthashMiner Integration Architecture

Integration contract between this dashboard and official
[CryptoGraphics/VerthashMiner](https://github.com/CryptoGraphics/VerthashMiner)
v0.7.2. The dashboard never speaks Stratum or `getblocktemplate` itself. It
spawns the miner as a child process, parses its stderr/stdout, and overlays
NVIDIA telemetry from `nvidia-smi`.

## Boundary

```
browser  --SSE/HTTP-->  dashboard (Node 18+)  --spawn/stdio-->  VerthashMiner
                              |                                      |
                              +-- nvidia-smi (read-only, on demand)  +-- stratum+tcp://pool
                                                                     +-- or http GBT (solo)
                                                                     +-- verthash.dat
```

There is no RPC listener, no daemon socket, and no in-process mining. The only
control plane is POSIX/Windows process lifecycle (`SIGINT` then force-kill) plus
the HTTP actions `POST /api/miner/{start,stop,restart}`.

## Process model

`MinerManager` (`server/miner/miner.js`) does two sequential launches:

1. **Device probe** — `spawn(MINER_EXE, ["--device-list"], { cwd: MINER_CWD })`.
   Stdout+stderr are captured (capped at `STREAM_BUFFER_BYTES`) and fed to
   `parseCudaDeviceList`. Probe timeout is `PROBE_TIMEOUT_MS` (8s). Failure is
   non-fatal: mining still starts, PCI→CUDA index mapping is simply empty.
2. **Miner** — `spawn(MINER_EXE, MINER_ARGS, { cwd: MINER_CWD, stdio: ["inherit","pipe","pipe"] })`.
   `--protocol-dump` is injected by `buildConfig` if the operator did not pass
   `-P` / `--protocol-dump`. Child priority is set to `PRIORITY_NORMAL` on
   Windows so the dashboard (which drops itself to `PRIORITY_BELOW_NORMAL`)
   does not steal GPU-host cycles.

Stop sequence: `SIGINT` → wait `FORCE_KILL_MS` (2s) → `SIGKILL` (or
`taskkill /T /F` on Windows) → give-up watchdog at `STOP_TIMEOUT_MS` (10s).
Official miner handles `SIGINT`/`SIGTERM`/`SIGHUP` in `on_signal` and drains
workio/stratum/worker threads.

Stdout/stderr are line-split by `createStreamReader` and parsed only while at
least one SSE subscriber is connected (`enableParsing` / `disableParsing`).

## Official CLI contract (v0.7.2)

| Flag | Short | Role for this dashboard |
| --- | --- | --- |
| `--url <addr>` | `-o` | Pool (`stratum+tcp://host:port`) or GBT (`http://127.0.0.1:port`) |
| `--user <user>` | `-u` | Wallet / worker. Dashboard extracts `WALLET` as the token before `.` |
| `--pass <pass>` | `-p` | Pool password (`c=VTC` on most Vertcoin pools, `x` if unused) |
| `--verthash-data <file>` | `-f` | Path to `verthash.dat` (required, ~1.2 GiB, static) |
| `--all-cu-devices` | | Select every CUDA device |
| `--all-cl-devices` | | Select every OpenCL device |
| `--cu-devices <list>` | `-D` | CUDA indices, optional `w/b/o/m/t` prefixes (`0:w131072:t79`) |
| `--cl-devices <list>` | `-d` | OpenCL indices, same prefix grammar |
| `--device-list` | `-l` | Probe-only: print devices and exit |
| `--protocol-dump` | `-P` | Dump stratum/GBT JSON. Auto-added by the dashboard |
| `--gen-verthash-data <file>` | | Generate `verthash.dat` (not invoked by the dashboard) |
| `--gen-conf <file>` | `-g` | Generate a `.conf` (not invoked by the dashboard) |
| `--config <file>` | `-c` | Load a `.conf`. Dashboard prefers raw CLI via `MINER_ARGS` |
| `--benchmark` | | Offline GPU bench (needs GPU + `verthash.dat`) |
| `--no-restrict-cuda` | | Allow NVIDIA cards on the OpenCL backend |
| `--log-file` | | Extra file logger; dashboard already captures stdio |

`deviceSelection()` understands `--all-cu-devices` / `--all-cl-devices` and
parses `--cu-devices` / `--cl-devices` (including `index:wN` prefixes — it uses
`parseInt`, so `0:w131072` becomes index `0`). The resulting `workerMap` remaps
`cu_device(worker)` / `cl_device(worker)` log indices onto physical device
indices for GPU-card overlay.

## Log grammar consumed by `parseMinerLine`

Official `applog` format (`src/vhCore/Util.cpp`):

```
[%Y-%m-%d %H:%M:%S] %-5s message
```

Levels: `ERROR`, `WARN`, `INFO`, `DEBUG`. `levelOf()` requires `[` at 0, `]` at
20, space at 21 — which matches four-digit years.

| Event | Official line (v0.7.2) | Dashboard effect |
| --- | --- | --- |
| Data file OK | `Verthash data file has been loaded succesfully!` | `SUCCESS` (matches the official typo `succes`) |
| Workers | `Configured N(CL) and M(CUDA) workers` | `expectedWorkers = N+M` |
| Threads | `N miner threads started, using Verthash algorithm.` | fallback `expectedWorkers` |
| Pool up | `Starting Stratum on stratum+tcp://…` | `CONNECTED` |
| Difficulty | `Stratum difficulty set to 1.5` | `mining.difficulty` |
| JSON difficulty | `> {"method": "mining.set_difficulty", "params": [1.5], …}` | same, via `RX_JSON_DIFF` |
| Per-GPU rate | `cu_device(0): err:0, temp:65C, power:180W, fan:50%, hashrate: 812.34 kH/s` | `gpuHashrates.cu_0`, status `MINING` |
| Totals | `accepted: 4/5 (80.00%), total hashrate: 812.34 kH/s` | accepted / submitted / rejected / total kH/s |
| Share reject | `"result": false, "error": [21, "Job not found"` | `jsonRejects++`, console error |
| Pool down | `Stratum connection failed` / `timed out` / `interrupted` | `DISCONNECTED` |
| GPU mem errors | `cu_device(0): Memory errors have been detected!` | `ERROR` log, not fatal |
| Device mem counter | `err:3,` inside a hashrate line | `WARN` |

`--protocol-dump` writes `> <json>` / `< <json>` (stratum) and
`JSON protocol request/response` (GBT). Lines containing `"id":` or `"method":`
are **not** mirrored into the web console; difficulty and reject payloads are
still extracted.

Hashrate unit is **kH/s** (`sprintf(s, "%.2f kH/s", hashrate)`). Stored as
`mining.hashrateKHs`.

## `--device-list` and PCI overlay

Probe output (CUDA path used by this dashboard):

```
Device list:
==================
OpenCL devices: None

CUDA devices:
	Index: 0. Name: NVIDIA GeForce RTX 3080. pcieId: 01:00:0
```

`parseCudaDeviceList` only maps the **CUDA** section. Official CUDA `pcieId` is
`%02x:%02x:0`. `nvidia-smi --query-gpu=pci.bus_id` typically returns
`00000000:01:00.0`. `normalizePci` keeps the last three colon/dot parts and
zero-pads the first two, so both become `01:00:0`. `hashrateForGpu` then joins
`state.gpu[i].pciBusId` → CUDA index → `gpuHashrates.cu_<index>`.

OpenCL-only rigs have no `nvidia-smi` overlay. Their hashrates still appear in
the totals via `cl_device(N)` lines.

Note the official typo `not avilable` when a bus id cannot be read — the parser
already treats that as unavailable.

## Protocols the miner speaks (not the dashboard)

- **Pooled:** Stratum over TCP (`stratum+tcp://`) or TLS (`stratum+tcps://`).
  Handshake: `mining.subscribe` → `mining.authorize` → `mining.set_difficulty`
  / `mining.notify` → `mining.submit`.
- **Solo:** Bitcoin-style `getblocktemplate` JSON-RPC over HTTP(S), optional
  long-poll. Requires `--coinbase-addr`.
- **Work file:** `verthash.dat`, generated with
  `VerthashMiner --gen-verthash-data verthash.dat` and SHA-256 verified against
  a hardcoded digest unless `--no-verthash-data_verification` is set.

The dashboard does not open any of those sockets.

## Runtime prerequisites

| Component | Requirement |
| --- | --- |
| Dashboard | Node.js 18+ (`node main.js`), no npm dependencies |
| Miner binary | Prebuilt [v0.7.2 release](https://github.com/CryptoGraphics/VerthashMiner/releases) or a CMake build |
| Miner build deps | OpenCL, Jansson, libcurl; OpenSSL on Unix; CUDA optional |
| GPU | NVIDIA SM 3.0+ (CUDA or OpenCL) or AMD GCN 1.0+ (OpenCL 1.2+), ≥2 GiB VRAM |
| Host GPU telemetry | `nvidia-smi` on `PATH` (Windows: `nvidia-smi.exe`). Polled only while a browser tab is open |
| Data file | `verthash.dat` in `MINER_CWD` (or an absolute `--verthash-data` path) |
| Mesa / macOS | Officially unsupported by VerthashMiner |

This sandbox cannot execute a real miner: there is no GPU, no OpenCL ICD, and
no `verthash.dat`. Handshake / share-flow verification is performed against
verbatim v0.7.2 log vectors through `parseMinerLine` and a child-process
stand-in that emits those vectors.

## Dashboard HTTP surface

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/`, `/index.html`, `/app.js`, `/style.css`, `/favicon.svg` | no | Bundled UI (allowlist only) |
| GET | `/health` | no | Liveness |
| GET | `/api/status` | cookie if `PASSPHRASE` set | Full snapshot |
| GET | `/events` | cookie if `PASSPHRASE` set | SSE `stats` frames |
| POST | `/api/login` | passphrase + CSRF header | Session cookie |
| POST | `/api/miner/start\|stop\|restart` | CSRF + optional cookie | Process control |

Bind `HOST=127.0.0.1` (default) or `0.0.0.0` (requires `PASSPHRASE`). Default
port `4067`. `SESSION_SECRET` is mandatory (≥32 chars recommended).

## Environment

See `.env.example`. Production-relevant keys:

- `SESSION_SECRET` — HMAC key for `vm_session` cookies
- `MINER_CWD` — working directory that contains the binary / `verthash.dat`
- `MINER_EXE` — `VerthashMiner.exe` on Windows, `VerthashMiner` elsewhere
- `MINER_ARGS` — forwarded argv; `--protocol-dump` appended automatically
- `HOST` / `PORT` / `PASSPHRASE`
- `GPU_POLL_MS` — clamped to 3000–10000
- `FORWARD_CONSOLE` — mirror miner stdio onto the launcher terminal

## Edge cases

- **Virtual devices** (`--cu-devices 0,0`): both workers map to `cu_0`, so
  per-GPU hashrate keeps the last worker only. The `accepted: … total hashrate`
  line still reports the true aggregate.
- **OpenCL-only AMD**: totals and console work; the GPU card grid stays empty
  without `nvidia-smi`.
- **Missing `verthash.dat`**: miner exits with
  `Verthash data file name is invalid` / load error → dashboard `CRASHED`.
- **No GPU in this environment**: `--device-list` prints
  `OpenCL devices: None` / `CUDA devices: None`; a real mine attempt exits
  `Found 0 configured workers`.
- **Reconnect**: official miner retries after `RetryPause` (default 30s) and
  logs `Stratum connection failed` / `…retry after N seconds`. Dashboard flips
  to `DISCONNECTED` on the error line and back to `MINING` on the next
  hashrate/`accepted:` line.
- **JSON reject vs accepted-line reject**: `rejected = submitted - accepted`.
  Extra rejects beyond `jsonRejects` emit a failsafe console line.

## Production launch

```bat
copy .env.example .env
node main.js --generate-secret
```

Fill `.env`:

```env
SESSION_SECRET=<64 hex chars>
MINER_CWD=C:\path\to\VerthashMiner
MINER_EXE=VerthashMiner.exe
MINER_ARGS=-u <WALLET> -p c=VTC -o stratum+tcp://pool.example.com:6144 --verthash-data verthash.dat --all-cu-devices
HOST=127.0.0.1
PORT=4067
```

```bat
node main.js
```

Generate the data file once, next to the miner binary:

```bat
VerthashMiner.exe --gen-verthash-data verthash.dat
```

Linux equivalent uses `MINER_EXE=VerthashMiner` and POSIX paths. Open
`http://127.0.0.1:4067`.
