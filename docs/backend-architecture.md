# Backend Architecture

Single Node process. Owns a VerthashMiner child, a read-only `nvidia-smi`
poller, and an HTTP/SSE control plane. Does not speak Stratum or
`getblocktemplate`. Operator setup lives in `README.md` and `.env.example`.

## Architectural routing map

| Component | Path | Responsibility | Interface |
| --- | --- | --- | --- |
| Entry / composition | `main.js` | Validate config, build `Server`, bind HTTP, auto-start miner, ordered shutdown | CLI: `node main.js`, `--generate-secret` |
| Config | `server/core/config.js` | Load `.env` (OS env wins), clamp, tokenize `MINER_ARGS`, inject `--protocol-dump`, derive wallet + device map | Env file / `process.env` |
| Constants | `server/core/constants.js` | Status enum, log types, numeric limits | In-process |
| State | `server/core/state.js` | `createState`, circular logs, `formatStatsSnapshot`, PCI→hashrate join | In-memory object |
| Timers | `server/core/timers.js` | `unref` setTimeout / setInterval | In-process |
| HTTP router | `server/http/http.js` | Method+path map, CSRF, body cap 4 KiB | TCP `HOST:PORT` (default `127.0.0.1:4067`) |
| SSE hub | `server/http/sse.js` | Snapshot fan-out, log deltas, heartbeat, 4-client cap | `GET /events` `text/event-stream` |
| Auth | `server/http/auth.js` | HMAC session cookie, timing-safe passphrase, IP lockout | Cookie `vm_session` |
| Rate limit | `server/http/ratelimit.js` | Per-route token buckets | `429` + `Retry-After` |
| Static + CSP | `server/http/static.js` | Allowlist assets, gzip, ETag | `GET / /index.html /app.js /style.css /favicon.svg` |
| Bundler | `server/http/bundle.js` | ESM → numbered IIFE from `web/core/app` | Build-once at listen |
| Miner manager | `server/miner/miner.js` | Probe, spawn, action debounce, SIGINT/kill | Child process stdio |
| Line parser | `server/miner/parser.js` | Status, shares, hashrate, difficulty, rejects | VerthashMiner applog + `--protocol-dump` |
| Device / PCI | `server/miner/devices.js` | `--device-list` parse, PCI normalize, stream splitter | Probe stdout |
| GPU poller | `server/miner/gpu.js` | Subscriber-gated `nvidia-smi` | Exec `nvidia-smi` / `nvidia-smi.exe` |

Demand gate: `SseHub` subscriber count > 0 enables parser + GPU poll. Zero
subscribers: miner keeps running, stdio is not tokenized, smi is idle.

## HTTP contract

| Method | Path | Auth | Body / query | Success payload |
| --- | --- | --- | --- | --- |
| GET | `/health` | none | — | `ok` text |
| GET | `/api/status` | cookie if `PASSPHRASE` | — | Snapshot JSON; may add `streamRetryAfterMs` |
| GET | `/events` | cookie if `PASSPHRASE` | — | SSE `event: stats` then `: hb` every 15s |
| POST | `/api/login` | CSRF header | `{ passphrase: string }` ≤4 KiB | `{ status: "ok" }` + `Set-Cookie` |
| POST | `/api/miner/start` | CSRF + cookie if set | — | `{ status: "ok" }` (action queued 2s) |
| POST | `/api/miner/stop` | same | — | `{ status: "ok" }` |
| POST | `/api/miner/restart` | same | — | `{ status: "ok" }` |

CSRF: `X-Requested-With: XMLHttpRequest` and same-origin `Origin` (or absent).
Non-loopback `HOST` without `PASSPHRASE` is fatal at boot.

Rate limits: login 10/10s, status 3/2s, events 3/2s, miner 2/2s. Sessions:
HMAC-SHA256(`SESSION_SECRET`, 32 random bytes), sliding 30 min, `HttpOnly`
`SameSite=Strict`. 5 login failures / 60s → 30s IP lockout.

SSE: max 4 clients; overflow sends `event: rejected`. First frame is a full
snapshot; later frames throttle 50ms and send `logsSince` deltas. Write-blocked
clients drop after 5 ticks.

## Snapshot fields (`formatStatsSnapshot`)

| Field | Type | Source |
| --- | --- | --- |
| `now` | number ms | clock |
| `uptimeSeconds` | number | `miner.startedAt` while running |
| `acceptedRatio` | number\|null | `100 * accepted / submitted` |
| `miner.running` `pid` `startedAt` `exitCode` `signal` | mixed | child |
| `miner.wallet` | string | `-u` before `.` |
| `miner.logs[]` | `{ id, text, type }` | ring, capacity 25 |
| `logsFrom` `logSeq` `logCount` `logCapacity` | number | ring metadata |
| `mining.status` | string | state machine below |
| `mining.hashrateKHs` | number\|null | sum of device rates or `accepted:` total |
| `mining.accepted` `submitted` `rejected` | number | `accepted: A/S` → A, S, S−A |
| `mining.difficulty` | number\|null | applog or protocol-dump JSON |
| `mining.lastAcceptedAt` | number\|null | last accept line |
| `gpu[]` | objects | smi row + `hashrate` via PCI join |
| `gpuError` | string | last smi failure |
| `host.hostname` `host.tz` | string | OS |

## Miner process contract

| Step | argv | Result |
| --- | --- | --- |
| Probe | `MINER_EXE --device-list` in `MINER_CWD`, 8s | CUDA section → `mining.pciMap[normalizedPci] = index` |
| Run | `MINER_EXE MINER_ARGS` (+ `--protocol-dump` if missing) | stdin inherit, stdout/stderr piped |
| Stop | `SIGINT` → 2s → `SIGKILL` or `taskkill /T /F` | 10s give-up → `STOPPED` |
| Restart | stop → 500ms → start | — |

`shell: false`. Empty `MINER_CWD` / `MINER_ARGS` stays `STOPPED` (dashboard
stays up). Probe failure is non-fatal.

`--cu-devices` / `--cl-devices` including `0:w131072` become integer indices
via `parseInt`. `--all-cu-devices` / `--all-cl-devices` set that side of
`workerMap` to `null` (worker index == device index).

## Stdio contract (VerthashMiner 0.7.2)

Applog: `[YYYY-MM-DD HH:MM:SS] %-5s message` on stderr. Levels `ERROR` `WARN`
`INFO` `DEBUG`.

| Official line | Parser write |
| --- | --- |
| `Starting Stratum on stratum+tcp://…` | `CONNECTED` |
| `cu_device(N): … hashrate: X kH/s` / `cl_device(N):` | `gpuHashrates.{cu,cl}_<mapped>=X`, maybe `MINING` |
| `accepted: A/S (…%), total hashrate: X kH/s` | A / S / S−A / total; `MINING` |
| `accepted: A/S … (pending...)` | shares only |
| `Stratum difficulty set to D` | `difficulty=D` |
| `"method": "mining.set_difficulty", "params": [D]` | same; line hidden from console |
| `"result": false, "error": [code, "reason"` | `jsonRejects++`, console reject; line hidden |
| `Configured N(CL) and M(CUDA) workers` | `expectedWorkers=N+M` |
| `N miner threads started` | fallback `expectedWorkers` |
| `Stratum connection failed\|timed out\|interrupted` | `DISCONNECTED` |
| `stratum_recv_line timed out`, `Stratum authentication failed`, `json_rpc_call failed` | `DISCONNECTED` |
| `Verthash data file has been loaded succesfully!` | console `SUCCESS` (official typo) |

JSON protocol lines (`"id":` or `"method":`) are not mirrored. PCI from probe
`pcieId: 01:00:0` and smi `00000000:01:00.0` both normalize to `01:00:0`.
Hashrate unit is kH/s.

```
STOPPED ─start→ STARTING ─"Starting Stratum"→ CONNECTED
                                    │
                         first hashrate / accepted
                                    ▼
         DISCONNECTED ← pool error  MINING  child death → CRASHED
                │                     ▲
                └──── next hashrate / accepted ────┘
```

`STOPPING` / `RESTARTING` / `STOPPED` ignore parser status writes.

## GPU poller

`nvidia-smi --query-gpu=name,temperature.gpu,power.draw,utilization.gpu,clocks.gr,clocks.mem,memory.used,memory.total,pstate,pci.bus_id --format=csv,noheader,nounits`

Start-to-start cooldown `GPU_POLL_MS` (clamped 3000–10000). Timeout 1500ms,
buffer 32 KiB. Three failures → exponential backoff to 120s. Read-only.

## Config derivation

File then OS. Fatal: missing `SESSION_SECRET`; non-local `HOST` without
`PASSPHRASE`. Advisories: short secret (<32), short passphrase (<8), LAN bind.
`WALLET` = `-u`/`--user` before `.`. Keys themselves are in `.env.example`.

## Shutdown

GPU stop → SSE close → miner SIGINT → HTTP close. 12s watchdog. Second Ctrl+C
during child stop is ignored. Windows: dashboard `PRIORITY_BELOW_NORMAL`,
child `PRIORITY_NORMAL`.
