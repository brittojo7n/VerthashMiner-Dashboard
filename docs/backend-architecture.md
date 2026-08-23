# Backend Architecture

This backend architecture is a lightweight, single-process Node.js management layer and web dashboard for **VerthashMiner** (v0.7.2). It does not interact with the mining pool directly over Stratum or handle mining algorithms internally; instead, it wraps the miner executable as a child process, monitors hardware health via `nvidia-smi`, and exposes an authenticated HTTP/Server-Sent Events (SSE) control plane.

---

## Architectural Component Map

```plain
                     ┌─────────────────────────────────────────┐
                     │          Browser / Dashboard            │
                     └────▲───────────────────────────────┬────┘
                 SSE Logs │ (Realtime deltas)             │ HTTP REST (Control/Auth)
                          │                               ▼
┌─────────────────────────┴──────────────────────────────────────────────────────┐
│ Single Node.js Host Process                                                    │
│                                                                                │
│  ┌────────────────────────┐  Demand Gate   ┌────────────────────────────────┐  │
│  │ HTTP & SSE Engine      │───────────────▶│ Central State Manager          │  │
│  │ (/api/*, /events, auth)│ (Active clients│ (Snapshots, ring log, PCI join)│  │
│  └────────────────────────┘  toggle poll)  └───────▲────────────────▲───────┘  │
│                                                    │                │          │
│                      ┌─────────────────────────────┘                │          │
│                      │ stdio applog / protocol stream               │ CSV poll │
│                      ▼                                              ▼          │
│  ┌────────────────────────────────────────┐  ┌──────────────────────────────┐  │
│  │ Miner Process Manager                  │  │ GPU Telemetry Poller         │  │
│  │ (Spawn, probe, debounce, kill tree)    │  │ (nvidia-smi CLI execution)   │  │
│  └───────────────────┬────────────────────┘  └──────────────┬───────────────┘  │
└──────────────────────┼──────────────────────────────────────┼──────────────────┘
                       ▼                                      ▼
           ┌──────────────────────┐               ┌───────────────────────┐
           │ VerthashMiner 0.7.2  │               │ NVIDIA Display Driver │
           │   (Child Process)    │               │     (GPU Metrics)     │
           └──────────────────────┘               └───────────────────────┘

```

| File / Component               | Role & Scope                                                                                                                                                                                    | Interfaces & I/O                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **`main.js`**                  | Bootstrapper; validates config, instantiates modules, binds the HTTP port, auto-starts the miner, and manages graceful process exits.                                                           | CLI: `node main.js`, `--generate-secret`                        |
| **`server/core/config.js`**    | Loads and clamps settings from `.env` (overridden by system environment variables), parses flags in `MINER_ARGS`, injects `--protocol-dump`, and extracts wallet addresses and device mappings. | Environment variables / `.env` file                             |
| **`server/core/constants.js`** | Single source of truth for status enums, log classifications, and hard runtime caps.                                                                                                            | Internal module exports                                         |
| **`server/core/state.js`**     | Holds the central in-memory state object, maintains a 25-entry ring log buffer, outputs structured snapshots, and merges GPU metrics with hashrates via PCI IDs.                                | In-memory reference                                             |
| **`server/core/timers.js`**    | Wraps `setTimeout` and `setInterval` with unreferenced (`unref()`) timers to prevent background tasks from keeping the event loop hostage during exits.                                         | Internal utilities                                              |
| **`server/http/http.js`**      | HTTP router, request size validator (capped at 4 KiB), and basic CSRF origin verification.                                                                                                      | TCP bind on `HOST:PORT` (Default: `127.0.0.1:4067`)             |
| **`server/http/sse.js`**       | SSE hub streaming real-time status snapshots and log deltas; manages heartbeats and enforces a strict 4-subscriber limit.                                                                       | `GET /events` (`text/event-stream`)                             |
| **`server/http/auth.js`**      | Verifies passphrases in constant time, issues HMAC-SHA256 signed session cookies, and handles brute-force IP lockouts.                                                                          | `Cookie: vm_session`                                            |
| **`server/http/ratelimit.js`** | In-memory token-bucket rate limiters applied per endpoint.                                                                                                                                      | Returns `429 Too Many Requests` + `Retry-After`                 |
| **`server/http/static.js`**    | Serves an allowlist of static assets with gzip compression, ETags, and strict Content Security Policy headers.                                                                                  | `GET /`, `/index.html`, `/app.js`, `/style.css`, `/favicon.svg` |
| **`server/http/bundle.js`**    | In-memory asset bundler that transforms frontend ESM source from `web/core/app` into an IIFE bundle when the server starts.                                                                     | In-memory build                                                 |
| **`server/miner/miner.js`**    | Orchestrates child process execution: hardware probing, process spawning, action debouncing, and multi-stage process termination.                                                               | `child_process` (stdio pipe)                                    |
| **`server/miner/parser.js`**   | Interprets VerthashMiner console logs (stderr) and parsed Stratum protocol lines to update state machine, share counts, hashrates, and pool errors.                                             | Subprocess stderr text stream                                   |
| **`server/miner/devices.js`**  | Evaluates output from `--device-list` probes and standardizes PCI identifiers across Windows and Linux formats.                                                                                 | Raw text parser                                                 |
| **`server/miner/gpu.js`**      | Periodically calls `nvidia-smi` to capture temperatures, clocks, utilization, and power draw.                                                                                                   | Subprocess execution of `nvidia-smi` / `nvidia-smi.exe`         |

---

## Demand-Gated Telemetry

To avoid burning host CPU cycles when no operators are actively watching the dashboard:

- **0 Active SSE Clients:** The miner runs untouched in the background, but standard output line tokenization and `nvidia-smi` subprocess polling are paused.
- **$\ge$ 1 Active SSE Client:** The stdio parser and GPU poller run at regular intervals.

---

## HTTP & SSE API Reference

All write actions require custom headers to prevent Cross-Site Request Forgery (CSRF). Requests must include `X-Requested-With: XMLHttpRequest` and provide matching or empty `Origin` headers. If the server is bound to a public network interface (`HOST !== 127.0.0.1` / `localhost`) without a configured `PASSPHRASE`, the application will abort startup immediately.

| Method   | Endpoint             | Auth                | Request Body                               | Rate Limit   | Behavior / Response                                                                                                                                                                                        |
| -------- | -------------------- | ------------------- | ------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GET**  | `/health`            | None                | None                                       | None         | Returns plain text `ok`.                                                                                                                                                                                   |
| **GET**  | `/api/status`        | Cookie (if enabled) | None                                       | 3 req / 2s   | Returns full JSON state snapshot. May include `streamRetryAfterMs` if SSE slots are saturated.                                                                                                             |
| **GET**  | `/events`            | Cookie (if enabled) | None                                       | 3 req / 2s   | Upgrades to SSE. First event is a complete state snapshot; subsequent events stream log deltas every 50ms (throttled) and `: hb` comments every 15s. Max 4 concurrent connections.                         |
| **POST** | `/api/login`         | CSRF header         | JSON `{"passphrase": "..."}` ($\le$ 4 KiB) | 10 req / 10s | Compares passphrase using constant-time evaluation. Sets a signed, sliding 30-minute `HttpOnly`, `SameSite=Strict` cookie (`vm_session`). 5 failed attempts in 60 seconds triggers a 30-second IP lockout. |
| **POST** | `/api/miner/start`   | CSRF + Cookie       | None                                       | 2 req / 2s   | Queues miner startup (debounced by 2 seconds).                                                                                                                                                             |
| **POST** | `/api/miner/stop`    | CSRF + Cookie       | None                                       | 2 req / 2s   | Sends `SIGINT` to child process tree.                                                                                                                                                                      |
| **POST** | `/api/miner/restart` | CSRF + Cookie       | None                                       | 2 req / 2s   | Initiates a stop, delays 500ms, then starts the child process again.                                                                                                                                       |

---

## In-Memory State Model (`formatStatsSnapshot`)

The backend holds application state in memory and emits normalized snapshots over HTTP and SSE:

- **Clock & Lifetime:** `now` (Unix timestamp in ms), `uptimeSeconds` (calculated from `miner.startedAt`).
- **Miner Process Status:** `miner.running` (boolean), `pid`, `startedAt`, `exitCode`, `signal`, and parsed wallet address `miner.wallet` (derived from the `-u`/`--user` flag up to the first worker dot `.`).
- **Ring Logs:** `miner.logs[]` (last 25 log entries structured as `{ id, text, type }`), tracked with sequence markers `logsFrom`, `logSeq`, `logCount`, and `logCapacity`.
- **Mining Metrics:**
- `mining.status`: State enum (`STOPPED`, `STARTING`, `CONNECTED`, `MINING`, `DISCONNECTED`, `CRASHED`).
- `mining.hashrateKHs`: Aggregated kH/s across all working threads/devices.
- `mining.accepted`, `mining.submitted`, `mining.rejected`: Parsed counters (rejected = submitted − accepted).
- `acceptedRatio`: Calculated as $(100 \times \text{accepted}) / \text{submitted}$.
- `mining.difficulty`: Active Stratum difficulty.
- `mining.lastAcceptedAt`: Timestamp of the most recently accepted share.

- **Hardware Telemetry:**
- `gpu[]`: Array of hardware metrics parsed from `nvidia-smi` joined with per-device hashrate by matching PCI bus addresses.
- `gpuError`: Error message captured from the last failed poller attempt.

- **Host Details:** `host.hostname`, `host.tz`.

---

## Subprocess Management & Parsing Contract

```plain
                     ┌───────────┐
                     │  STOPPED  │
                     └─────┬─────┘
                           │ miner.start()
                           ▼
                     ┌───────────┐
                     │ STARTING  │
                     └─────┬─────┘
                           │ "Starting Stratum on stratum+tcp://..."
                           ▼
                     ┌───────────┐
      ┌─────────────▶│ CONNECTED │◀─────────────┐
      │              └─────┬─────┘              │
      │                    │                    │
      │                    │ First Hashrate /   │ Stratum reconnect /
      │                    │ Accepted Share     │ new hashrate
      │                    ▼                    │
Pool Error /         ┌───────────┐              │
Stratum Timeout      │  MINING   │──────────────┘
      │              └─────┬─────┘
      │                    │
      ▼                    │ Process death
┌──────────────┐           ▼
│ DISCONNECTED │     ┌───────────┐
└──────────────┘     │  CRASHED  │
                     └───────────┘

```

### 1. Hardware Probe

Before starting the miner process, the backend runs `MINER_EXE --device-list` inside `MINER_CWD` with an 8-second timeout. It parses the CUDA devices and constructs a normalization map between hardware PCI IDs and miner device indices (`mining.pciMap[normalizedPci] = index`).

- PCI strings such as probe output `pcieId: 01:00:0` and `nvidia-smi` output `00000000:01:00.0` are normalized to `01:00:0`.
- Flags like `--cu-devices 0:w131072` are parsed with `parseInt` to extract device `0`. Flags like `--all-cu-devices` map workers 1:1 with hardware indices.

### 2. Process Execution

The miner runs using `child_process.spawn` with `shell: false`. It inherits `stdin`, while `stdout` and `stderr` are piped for parsing. If `MINER_CWD` or `MINER_ARGS` are missing, the server remains in a `STOPPED` state without crashing the web service.

### 3. Log Stream Parsing (VerthashMiner 0.7.2)

The parser matches standard log lines formatted as `[YYYY-MM-DD HH:MM:SS] %-5s message` along with raw JSON output injected via `--protocol-dump`:

- **Stratum Connection:** Logs containing `Starting Stratum on stratum+tcp://...` transition the state to `CONNECTED`.
- **Hashrate Outputs:** Lines like `cu_device(N): ... hashrate: X kH/s` or `cl_device(N):` assign hashrates to individual devices and promote the state to `MINING`.
- **Share Submissions:** `accepted: A/S (..%), total hashrate: X kH/s` updates accepted, submitted, and total hashrate values. Lines indicating `(pending...)` update share tallies without modifying final hashrate calculations.
- **Network & Work Difficulty:** Strings matching `Stratum difficulty set to D` or protocol JSON lines `{"method": "mining.set_difficulty", "params": [D]}` update the stored difficulty.
- **Stratum Errors & Dropouts:** Applog lines indicating connection failure, timeouts (`stratum_recv_line timed out`), or auth rejections transition state to `DISCONNECTED`. Protocol errors (`"result": false, "error": [...]`) increment internal reject metrics.
- **Known Quirks:** The official typo string `Verthash data file has been loaded succesfully!` is mapped to a `SUCCESS` system log category. Protocol JSON-RPC lines are hidden from the raw web console to avoid spamming the log view.

---

## GPU Telemetry Polling (`nvidia-smi`)

The poller executes the following read-only command:

```bash
nvidia-smi --query-gpu=name,temperature.gpu,power.draw,utilization.gpu,clocks.gr,clocks.mem,memory.used,memory.total,pstate,pci.bus_id --format=csv,noheader,nounits

```

- **Execution Interval:** Runs every `GPU_POLL_MS` (clamped between 3,000 ms and 10,000 ms).
- **Execution Guards:** Guarded by a 1,500 ms process timeout and a 32 KiB buffer cap.
- **Backoff Strategy:** If the command fails three consecutive times, the poller applies exponential backoff, scaling up to a 120-second retry delay.

---

## Process Teardown & Priority Handling

When a shutdown signal (`SIGINT` or `SIGTERM`) is received, the backend executes an ordered teardown backed by a 12-second hard watchdog timer:

```plain
[Trigger Shutdown]
        │
        ▼
1. Halt GPU Polling (clear timers)
        │
        ▼
2. Terminate Active SSE Connections (flush & close sockets)
        │
        ▼
3. Signal Miner Child Process (send SIGINT)
        │
        ├─▶ Process exits within 2s ───┐
        │                              │
        ▼ (Timeout after 2s)           │
   Escalate to SIGKILL / taskkill /T /F│
        │                              │
        ├──────────────────────────────┘
        ▼
4. Close HTTP Listening Server
        │
        ▼
[Clean Process Exit (0)]

```

- **Signal Handling:** A second `Ctrl+C` received while waiting for the miner child process to exit is ignored to prevent leaving orphaned background mining processes.
- **Windows Process Priority:** On Windows systems, the Node.js dashboard process runs with `PRIORITY_BELOW_NORMAL` so web rendering never steals CPU scheduling from the `PRIORITY_NORMAL` mining child process.
