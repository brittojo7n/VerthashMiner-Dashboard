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
| **`server/miner/parser.js`**   | Interprets VerthashMiner console logs (stdout and stderr) and parsed Stratum protocol lines to update state machine, share counts, hashrates, and pool errors.                                  | Subprocess stdio text stream                                    |
| **`server/miner/devices.js`**  | Evaluates output from `--device-list` probes and standardizes PCI identifiers across Windows and Linux formats.                                                                                 | Raw text parser                                                 |
| **`server/miner/gpu.js`**      | Periodically calls `nvidia-smi` to capture temperatures, clocks, utilization, and power draw.                                                                                                   | Subprocess execution of `nvidia-smi` / `nvidia-smi.exe`         |

There is no database and no inter-process message bus. Every HTTP handler and SSE frame reads the same in-memory state object; writers flip `state.dirty` so the hub can serialize a snapshot.

---

## Demand-Gated Telemetry

To avoid burning host CPU cycles when no operators are actively watching the dashboard:

- **0 Active SSE Clients:** The miner runs untouched in the background, but standard output line tokenization and `nvidia-smi` subprocess polling are paused.
- **$\ge$ 1 Active SSE Client:** The stdio parser and GPU poller run at regular intervals.

Subscriber count is reported by the SSE hub into `Server._onSubscriberChange`, which toggles `MinerManager.enableParsing()` / `disableParsing()` and `GpuManager.updateSubscribers()`. Opening the first tab also forces a catch-up broadcast so the new client is not staring at a stale ring.

---

## Configuration Loading & Validation

`server/core/config.js` reads a dotenv-style file (default `.env` next to `main.js`, or the path in `ENV_FILE`) and copies only keys that are not already present on `process.env`. Operating-system environment variables therefore always win.

After the file is merged, `buildConfig` derives the frozen runtime object:

- **`PORT`** is clamped to $0$–$65535$ (default $4067$). **`GPU_POLL_MS`** is clamped to $3000$–$10000$ (default $5000$). Out-of-range values produce a startup advisory rather than a crash.
- **`MINER_ARGS`** is split with a quote-aware tokenizer. If neither `-P` nor `--protocol-dump` is present, `--protocol-dump` is appended so share rejects and `mining.set_difficulty` appear on stdio.
- **`WALLET`** is the `-u` / `--user` token up to the first worker-separator `.`.
- **`DEVICE_SELECTION`** is built from `--all-cu-devices` / `--all-cl-devices` and the index lists on `--cu-devices` / `-D` and `--cl-devices` / `-d`. Prefixed tokens such as `0:w131072` parse as index $0$ via `parseInt`. An `--all-*` flag stores `null` on that side, meaning worker index equals hardware index.
- **`MINER_EXE`** defaults to `VerthashMiner.exe` on Windows and `VerthashMiner` elsewhere. **`FORWARD_CONSOLE`** is true only when the env value is the literal string `true`.

Validation is split into two classes. Missing `SESSION_SECRET`, or a non-loopback `HOST` (`127.0.0.1`, `localhost`, and `::1` are the only local values) without a `PASSPHRASE`, is fatal and the process exits before binding a port. Short secrets (under $32$ characters), short passphrases (under $8$ characters), and LAN binds are printed as advisories and the server continues.

Individual key names and operator setup live in `.env.example` and `README.md`.

---

## HTTP & SSE API Reference

All write actions require custom headers to prevent Cross-Site Request Forgery (CSRF). Requests must include `X-Requested-With: XMLHttpRequest` and provide matching or empty `Origin` headers. If the server is bound to a public network interface (`HOST !== 127.0.0.1` / `localhost` / `::1`) without a configured `PASSPHRASE`, the application will abort startup immediately.

When `PASSPHRASE` is empty, authentication is off: `/api/login` returns `404`, and miner control routes still require the CSRF header but no cookie. When a passphrase is set, every API path except `/api/login` requires a valid `vm_session` cookie.

| Method   | Endpoint             | Auth                | Request Body                               | Rate Limit   | Behavior / Response                                                                                                                                                                                        |
| -------- | -------------------- | ------------------- | ------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GET**  | `/health`            | None                | None                                       | None         | Returns plain text `ok`.                                                                                                                                                                                   |
| **GET**  | `/api/status`        | Cookie (if enabled) | None                                       | 3 req / 2s   | Returns full JSON state snapshot. If this IP was recently rate-limited on `/events`, the snapshot also carries `streamRetryAfterMs` / `streamRetryAfterSeconds` so the UI can wait before reopening SSE.   |
| **GET**  | `/events`            | Cookie (if enabled) | None                                       | 3 req / 2s   | Upgrades to SSE. Emits `: stream established`, then a complete `event: stats` snapshot; subsequent stats frames are throttled to 50ms and carry only logs newer than that client’s sequence. Heartbeat comments (`: hb`) every 15s. Max 4 concurrent connections; overflow receives `event: rejected`. |
| **POST** | `/api/login`         | CSRF header         | JSON `{"passphrase": "..."}` ($\le$ 4 KiB) | 10 req / 10s | Compares passphrase using SHA-256 then `timingSafeEqual`. Sets a signed, sliding 30-minute `HttpOnly`, `SameSite=Strict` cookie (`vm_session`). 5 failed attempts in 60 seconds triggers a 30-second IP lockout. Absent when auth is disabled (`404`). |
| **POST** | `/api/miner/start`   | CSRF + Cookie       | None                                       | 2 req / 2s   | Queues miner startup (debounced by 2 seconds).                                                                                                                                                             |
| **POST** | `/api/miner/stop`    | CSRF + Cookie       | None                                       | 2 req / 2s   | Queues a graceful stop (`SIGINT`, then force-kill).                                                                                                                                                        |
| **POST** | `/api/miner/restart` | CSRF + Cookie       | None                                       | 2 req / 2s   | Queues stop, waits 500ms, then start.                                                                                                                                                                      |

Rate-limit trips include a 3-second penalty window and return JSON `{ error: "rate_limited", retryAfterMs, retryAfterSeconds, message }` plus a `Retry-After` header. Login bodies over 4 KiB receive `413` and the socket is closed. Malformed HTTP is answered with a hard `400` close.

Transport timeouts on the listening server are 20s for headers, 30s per request, 5s keep-alive, and a 64-header cap. SSE sockets disable the request timeout so the stream can stay open.

Session tokens are `HMAC-SHA256(SESSION_SECRET, 32 random bytes)`, stored server-side (maximum 50 live sessions) with a sliding 30-minute TTL. The store prunes expired entries on issue and on `/events` authentication.

---

## In-Memory State Model (`formatStatsSnapshot`)

The backend holds application state in memory and emits normalized snapshots over HTTP and SSE:

- **Clock & Lifetime:** `now` (Unix timestamp in ms), `uptimeSeconds` (calculated from `miner.startedAt` while the child is running; $0$ otherwise).
- **Miner Process Status:** `miner.running` (boolean), `pid`, `startedAt`, `exitCode`, `signal`, `lastLine`, `lastError`, parsed wallet address `miner.wallet`, and optional worker name `miner.worker`. Both identity fields come from the `-u` / `--user` argument: text before the first `.` is the wallet; non-empty text after it is the worker. A trailing dot with no worker name is stripped and `miner.worker` is `null`.
- **Ring Logs:** `miner.logs[]` (last 25 log entries structured as `{ id, text, type }`), tracked with sequence markers `logsFrom`, `logSeq`, `logCount`, and `logCapacity`. SSE clients receive a delta via `logsSince` so they do not re-download the whole ring.
- **Mining Metrics:**
  - `mining.status`: State enum (`STOPPED`, `STARTING`, `STOPPING`, `RESTARTING`, `CONNECTED`, `WAITING`, `MINING`, `DISCONNECTED`, `CRASHED`).
  - `mining.hashrateKHs`: Aggregated kH/s across all working threads/devices.
  - `mining.accepted`, `mining.submitted`, `mining.rejected`: Parsed counters (rejected = submitted − accepted).
  - `acceptedRatio`: Calculated as $(100 \times \text{accepted}) / \text{submitted}$, or `null` when nothing has been submitted.
  - `mining.difficulty`: Active Stratum difficulty.
  - `mining.lastAcceptedAt`: Timestamp of the most recently accepted share.
- **Hardware Telemetry:**
  - `gpu[]`: Array of hardware metrics parsed from `nvidia-smi` joined with per-device hashrate by matching PCI bus addresses (`index`, `name`, `temperatureC`, `powerW`, `utilizationPct`, `coreMHz`, `memoryMHz`, `memoryUsedMB`, `memoryTotalMB`, `pstate`, `pciBusId`, `hashrate`).
  - `gpuError`: Error message captured from the last failed poller attempt.
- **Host Details:** `host.hostname`, `host.tz` (formatted as `UTC±HH:MM`).

Internal fields that do not leave the process include `mining.gpuHashrates`, `mining.pciMap`, `mining.workerMap`, `mining.expectedWorkers`, `mining.hashratesReady`, `mining.seenDevices`, and `mining.jsonRejects`. Those exist only so the parser and PCI join can keep the public snapshot consistent.

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

Operator actions overlay this machine rather than replacing it. `stop` writes `STOPPING` and then `STOPPED`. `restart` writes `RESTARTING`, tears the child down, and re-enters `STARTING`. Lines that mention waiting, paused, or no work move a live miner to `WAITING` until the next hashrate or accept. `STOPPING`, `RESTARTING`, and `STOPPED` are sticky: the parser will not overwrite them with a late log line.

A deliberate stop that exits with code $0$ stays `STOPPED`. Any other non-zero exit or signal becomes `CRASHED`.

### 1. Hardware Probe

Before starting the miner process, the backend runs `MINER_EXE --device-list` inside `MINER_CWD` with an 8-second timeout. Combined stdout and stderr (capped at 16 KiB) are parsed. Only the CUDA section is mapped, producing `mining.pciMap[normalizedPci] = index`.

- PCI strings such as probe output `pcieId: 01:00:0` and `nvidia-smi` output `00000000:01:00.0` are normalized to `01:00:0`.
- Flags like `--cu-devices 0:w131072` are parsed with `parseInt` to extract device $0$. Flags like `--all-cu-devices` map workers 1:1 with hardware indices.
- Probe failure or timeout is non-fatal. Mining still starts; the PCI join is simply empty and per-GPU hashrate overlay will fall back to device index.
- Official device-list text uses the typo `not avilable` when a bus id cannot be read; those rows are skipped.

### 2. Process Execution

The miner runs using `child_process.spawn` with `shell: false` and an argv array (no shell interpolation). It inherits `stdin`, while `stdout` and `stderr` are piped for parsing. If `MINER_CWD` or `MINER_ARGS` are missing, the server remains in a `STOPPED` state without crashing the web service.

`createStreamReader` splits each pipe on newlines and retains at most a 16 KiB tail if a line never arrives. When `FORWARD_CONSOLE` is enabled, raw bytes are also mirrored onto the launcher terminal. Parsing itself only runs while at least one SSE client is connected.

### 3. Action Queue

`POST /api/miner/{start,stop,restart}` does not spawn or kill immediately. `requestAction` writes the transitional status (`STARTING` / `STOPPING` / `RESTARTING`), waits 2 seconds, then invokes the corresponding method.

- A second click of the same action is ignored.
- A different action cancels the pending timer and restores the previous status before queueing the new one.
- `restart` while idle degenerates to `start`.
- `stop` while idle is a no-op (and forces `STOPPED` if the status had drifted).

Restart after a live child is stop → 500ms gap → start.

### 4. Log Stream Parsing (VerthashMiner 0.7.2)

The parser matches standard log lines formatted as `[YYYY-MM-DD HH:MM:SS] %-5s message` along with raw JSON output injected via `--protocol-dump`. Official levels are `ERROR`, `WARN`, `INFO`, and `DEBUG`.

- **Stratum Connection:** Logs containing `Starting Stratum on stratum+tcp://...` (or, on older builds, both `stratum` and `connect`) transition the state to `CONNECTED`.
- **Worker Census:** `Configured N(CL) and M(CUDA) workers` sets `expectedWorkers = N + M`. `N miner threads started` is the fallback when the configured-workers line never appears. Totals are not published until every expected worker has reported a hashrate (or a device key repeats).
- **Hashrate Outputs:** Lines like `cu_device(N): err:0, temp:64C, power:210W, fan:48%, hashrate: X kH/s` or `cl_device(N):` assign hashrates to `gpuHashrates.{cu,cl}_<mapped>` and promote the state to `MINING`. A non-zero `err:N,` memory-error counter on an otherwise healthy line is classified as a warning, not a crash.
- **Share Submissions:** `accepted: A/S (..%), total hashrate: X kH/s` updates accepted, submitted, rejected ($S - A$), and total hashrate values. Lines indicating `(pending...)` update share tallies without modifying final hashrate calculations.
- **Network & Work Difficulty:** Strings matching `Stratum difficulty set to D` or protocol JSON lines `{"method": "mining.set_difficulty", "params": [D]}` update the stored difficulty.
- **Stratum Errors & Dropouts:** Applog lines indicating connection failure, timeouts (`stratum_recv_line timed out`), authentication failure, or `json_rpc_call failed` transition state to `DISCONNECTED` rather than `CRASHED`. The official miner retries on its own; the next hashrate or accept returns `MINING`.
- **JSON Rejects:** Protocol dumps of the form `"result": false, "error": [code, "reason"` increment `jsonRejects` and emit a console reject line. If `submitted - accepted` grows faster than those JSON rejects, a failsafe reject line is synthesized for the unexplained remainder.
- **Known Quirks:** The official typo string `Verthash data file has been loaded succesfully!` is mapped to a `SUCCESS` system log category. Protocol JSON-RPC lines (`"id":` or `"method":`) are hidden from the raw web console to avoid spamming the log view; difficulty and reject payloads inside them are still applied.
- **Virtual Devices:** Two workers pinned to the same index (`--cu-devices 0,0`) share one `cu_0` slot, so the per-GPU overlay keeps the last worker only. The `accepted:` total hashrate remains the true aggregate.

---

## GPU Telemetry Polling (`nvidia-smi`)

The poller executes the following read-only command:

```bash
nvidia-smi --query-gpu=name,temperature.gpu,power.draw,utilization.gpu,clocks.gr,clocks.mem,memory.used,memory.total,pstate,pci.bus_id --format=csv,noheader,nounits
```

- **Execution Interval:** Runs every `GPU_POLL_MS` (clamped between 3,000 ms and 10,000 ms), measured start-to-start so extra SSE clients or tab refreshes cannot stack overlapping polls.
- **Execution Guards:** Guarded by a 1,500 ms process timeout and a 32 KiB buffer cap.
- **Backoff Strategy:** If the command fails three consecutive times, the poller applies exponential backoff, scaling up to a 120-second retry delay.
- **PCI Join:** `hashrateForGpu` looks up `pciMap[gpu.pciBusId]` and then `gpuHashrates.cu_<index>`, falling back to `cl_<index>`. OpenCL-only hosts still receive aggregate hashrate from `cl_device` lines; the card grid stays empty without `nvidia-smi`.
- **Scope:** The poller never writes clocks, power limits, or fan curves. It is observation only.

---

## Static Asset Composition

At listen time `buildAssets` reads `web/`, rewrites the HTML module tag to `/app.js`, and runs the import/export transformer in `server/http/bundle.js` over the graph starting at `core/app`. The result is a single IIFE with numeric module ids. Internal source paths such as `/web/*` and `/js/*` are never registered.

Compressible assets of at least 512 bytes are gzipped once. Responses honor `ETag` / `If-None-Match` and `Accept-Encoding`. HTML carries a strict Content Security Policy (`default-src 'self'`, no `object-src`, no `form-action`) and a disabled Permissions Policy. There is no watch mode and no source map.

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
        ├─▶ Still alive at 10s: give up│
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
- **Fault Isolation:** Uncaught exceptions and unhandled promise rejections are logged into the miner ring as dashboard errors; they do not tear the child down. Bind failures (`EADDRINUSE`, bad `HOST`) exit immediately with a fatal message.
