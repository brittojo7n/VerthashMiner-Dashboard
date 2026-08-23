# Backend Architecture

The dashboard is a single Node process that owns three things: a child miner, a
read-only `nvidia-smi` poller, and an HTTP/SSE control plane. It never opens a
Stratum or `getblocktemplate` socket. Mining, pool auth, share submit, and
`verthash.dat` handling stay inside VerthashMiner; this process only launches
it, reads its stdio, and publishes a derived snapshot.

Operator setup, env keys, and the on-disk layout live in `README.md` and
`.env.example`. This note is the runtime contract.

## Process composition

`main.js` validates config, then constructs one `Server`. That object is the
composition root:

```
                    ┌─────────────┐
   SIGINT/TERM ───► │   Server    │
                    └──────┬──────┘
           ┌───────────────┼────────────────┐
           ▼               ▼                ▼
     MinerManager     GpuManager         SseHub
      spawn/stdio      nvidia-smi      snapshot fan-out
           │               │                ▲
           └──────► state.dirty ────────────┘
                           │
                     createHttpServer
                    routes + static bundle
```

Shared mutable state is a single object from `createState()`:

- `miner` — child liveness, pid, exit, circular log buffer
- `mining` — status, shares, difficulty, per-worker hashrates, PCI map
- `gpu` — last `nvidia-smi` rows
- `dirty` — set whenever anything a subscriber would see changes

There is no database and no message bus. HTTP handlers read that object;
`SseHub.broadcast()` serializes it.

On Windows the dashboard drops itself to `PRIORITY_BELOW_NORMAL` and raises the
child to `PRIORITY_NORMAL` so the host process does not compete with hashing.

Shutdown is ordered: stop GPU polling, close SSE clients, `SIGINT` the miner,
close the HTTP server. A 12s watchdog force-exits if any step hangs. A second
Ctrl+C while the child is already stopping is ignored so the stop sequence is
not re-entered.

## Demand-driven work

Stdio parsing and `nvidia-smi` only run while at least one SSE client is
connected. `SseHub` reports subscriber count; `Server._onSubscriberChange`
toggles both subsystems.

With no browser tab the miner still runs, but its output is not tokenized and
the GPU poller is idle. Opening a tab enables parsing (and a catch-up
broadcast) and starts the poller. Closing the last tab disables both.

That is the main CPU/IO lever. The miner child is independent of it.

## Configuration pipeline

`server/core/config.js` loads a dotenv-style file (default `.env`, override
`ENV_FILE`) and fills only keys that are not already in `process.env`. OS
environment therefore wins.

`buildConfig` then:

1. Clamps `PORT` and `GPU_POLL_MS` into safe ranges.
2. Tokenizes `MINER_ARGS` with a quote-aware splitter.
3. Injects `--protocol-dump` unless `-P` is already present. Protocol dump is
   how share rejects and `mining.set_difficulty` become visible on stdio.
4. Derives `WALLET` from `-u` / `--user` (text before the first `.`).
5. Derives `DEVICE_SELECTION` from `--all-cu-devices` / `--all-cl-devices` and
   the index lists on `--cu-devices` / `--cl-devices`. Prefixed tokens such as
   `0:w131072` parse as index `0` via `parseInt`.

Validation is split. Missing `SESSION_SECRET`, or a non-loopback `HOST`
without `PASSPHRASE`, is fatal and the process exits. Short secrets, short
passphrases, and LAN binds are advisories printed at start.

## Miner lifecycle

`MinerManager` is the only code that creates or kills the child.

**Start.** If `MINER_CWD` or `MINER_ARGS` is empty the manager stays `STOPPED`
and records the reason; it does not crash the dashboard. Otherwise it resets
share/hashrate stats and runs two sequential spawns:

1. Probe — `MINER_EXE --device-list` in `MINER_CWD`, 8s watchdog. Combined
   stdout/stderr (capped) is parsed into `mining.pciMap`. Probe failure is
   non-fatal; mining still starts without a PCI join.
2. Miner — `MINER_EXE MINER_ARGS` with stdin inherited and both output pipes
   captured. `shell: false`, argv array, no interpolation.

**Streams.** `createStreamReader` splits on newlines, bounds a 16 KiB tail if
a line never arrives, optionally mirrors bytes to the launcher terminal
(`FORWARD_CONSOLE`), and calls `parseMinerLine` only when parsing is enabled.

**Actions.** `POST /api/miner/{start,stop,restart}` does not spawn immediately.
`requestAction` writes a transitional status (`STARTING` / `STOPPING` /
`RESTARTING`), waits 2s, then runs the method. A second click of the same
action is ignored; a different action cancels the pending one and restores the
previous status. Idle `restart` degenerates to `start`. Idle `stop` is a no-op.

**Stop.** `SIGINT` the child, then after 2s `SIGKILL` (Unix) or
`taskkill /T /F` (Windows process tree). A 10s watchdog gives up and marks
`STOPPED` even if the OS has not reaped the pid. Restart is stop → 500ms gap →
start.

**Exit classification.** A deliberate stop stays `STOPPED` / `STOPPING`. Any
other non-zero exit or signal becomes `CRASHED`.

## Mining state machine

`parseMinerLine` is the only writer of live mining fields. It classifies each
line (official applog is `[YYYY-MM-DD HH:MM:SS] LEVEL message`) and updates
status, counters, and hashrates in place.

```
STOPPED ──start──► STARTING ──"Starting Stratum on …"──► CONNECTED
                                    │
                                    ▼
                              first cu_/cl_ hashrate
                              or accepted: N/M
                                    │
                                    ▼
                                 MINING ◄──── hashrate / accepted
                                    │
                    pool error      │      child death
                         ▼          │           ▼
                  DISCONNECTED ─────┘       CRASHED
                         │
                         └── next hashrate / accepted ──► MINING
```

`STOPPING` / `RESTARTING` / `STOPPED` are sticky: parser status writes are
suppressed so a late log line cannot flip a miner that is already being torn
down.

**Shares.** Official `accepted: A/S` is treated as accepted=`A`, submitted=`S`,
rejected=`S-A`. `--protocol-dump` JSON of the form
`"result": false, "error": [code, "reason"` increments `jsonRejects` and
prints a console reject. If `S-A` grows faster than those JSON rejects, a
failsafe reject line is synthesized.

**Hashrate.** `cu_device(N)` / `cl_device(N)` lines (optional `err:` / `temp:` /
`power:` / `fan:` prefix) write `gpuHashrates.{cu,cl}_<mapped>`. The total is
the sum of those keys once every expected worker has reported, or the
`total hashrate` field on the `accepted:` line when it is not `(pending...)`.
Units are kH/s, stored as `hashrateKHs`.

`expectedWorkers` comes from `Configured N(CL) and M(CUDA) workers`, with
`N miner threads started` as fallback. `workerMap` from `DEVICE_SELECTION`
remaps the `N` in `cu_device(N)` onto the physical index used by the GPU
overlay. Two virtual workers on the same index (`--cu-devices 0,0`) share one
slot; the accepted-line total is still the true aggregate.

**Protocol dump.** Lines containing `"id":` or `"method":` are not appended to
the web console. Difficulty and reject payloads inside them are still applied.

**Pool loss.** `Stratum connection failed|timed out|interrupted`,
`stratum_recv_line timed out`, `Stratum authentication failed`, and related
`json_rpc_call failed` patterns set `DISCONNECTED` rather than `CRASHED`. The
official miner retries on its own; the next hashrate or accept returns
`MINING`.

Logs sit in a 25-entry circular buffer with monotonic ids. The snapshot can
return a delta (`logsSince`) so SSE clients do not re-download the whole ring.

## GPU overlay

`GpuManager` execs `nvidia-smi --query-gpu=… --format=csv,noheader,nounits`
with a 1.5s timeout and a 32 KiB cap. It is start-to-start cooled by
`GPU_POLL_MS` (clamped 3–10s). Extra SSE clients or tab refreshes cannot stack
polls. After three consecutive failures the interval doubles up to 120s.

`normalizePci` reduces both the miner probe id (`01:00:0`) and the smi bus id
(`00000000:01:00.0`) to the last three colon/dot parts. `hashrateForGpu` then
does `pciMap[bus] → cu_<index>` (OpenCL key as fallback). OpenCL-only hosts
still get totals from `cl_device` lines; the card grid stays empty without
smi.

Smi is read-only. Clock, power, and fan changes are not issued from this
process.

## HTTP control plane

`createHttpServer` is a plain `http.createServer` with a method+path map. No
framework, no CORS wide-open, no directory listing.

| Surface | Role |
| --- | --- |
| Static allowlist | HTML/CSS/JS/SVG built once at listen |
| `GET /health` | Liveness, unauthenticated |
| `GET /api/status` | Full snapshot; if this IP is SSE-locked it also carries `streamRetryAfterMs` |
| `GET /events` | SSE `stats` events |
| `POST /api/login` | Passphrase → `vm_session` cookie |
| `POST /api/miner/*` | Action queue described above |

When `PASSPHRASE` is set, every API except login requires a valid cookie.
Login and miner POSTs also require `X-Requested-With: XMLHttpRequest` and a
same-origin `Origin` (or no Origin). Bodies are capped at 4 KiB.

**Sessions.** Tokens are HMAC-SHA256(`SESSION_SECRET`, 32 random bytes), stored
server-side with a sliding 30-minute TTL, `HttpOnly` + `SameSite=Strict`.
Passphrase compare is SHA-256 then `timingSafeEqual`, so length does not leak.
Five failures in a minute lock the IP for 30s.

**Rate limits.** Independent token buckets: login 10/10s, status 3/2s, events
3/2s, miner actions 2/2s, each with a penalty window. `429` includes
`Retry-After` and JSON. Events additionally parks the IP in `streamBlocks` so
status can tell the UI how long to wait before reopening SSE.

**SSE.** Cap of 4 live clients; dead sockets are reaped before the cap is
enforced, otherwise the new socket gets `event: rejected`. First frame is a
full snapshot; later frames are throttled to 50ms and carry only logs newer
than that client’s `lastLogSeq`. A 15s comment heartbeat keeps proxies from
idling the socket out. A client that stays write-blocked for five ticks is
dropped.

Request timeouts: 20s headers, 30s request, 5s keep-alive, 64 header cap.
`clientError` is a hard `400` close.

## Asset composition

At listen time `buildAssets` reads `web/`, rewrites the HTML module tag to
`/app.js`, and runs a tiny import/export transformer (`server/http/bundle.js`)
over the `web/` graph starting at `core/app`. The result is one IIFE with
numeric module ids — no `/web/*` or `/js/*` URL is ever registered.

Compressible assets ≥512 B are gzipped once. Responses honor `ETag` /
`If-None-Match` and `Accept-Encoding`. HTML carries a strict CSP
(`default-src 'self'`, no object, no form-action) plus a disabled Permissions
Policy. That is the whole delivery path; there is no watch mode and no source
map.
