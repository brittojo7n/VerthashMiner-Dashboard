# Internals

The runtime sources (`server.js`, `src/`, `public/js/`, `public/style.css`) are kept
comment-free. This file is where the "why" lives: the non-obvious invariants that the code
depends on, and the reasons behind decisions that look arbitrary until you know the context.
Each rule below is enforced by a named test — grep the test suite for the quoted name.

---

## Miner console format (upstream contract)

VerthashMiner routes every message through one `applog()` call
(`src/vhCore/Util.cpp:88`) and writes to **stderr**:

```
[YYYY-MM-DD HH:MM:SS] LEVEL message      LEVEL padded to 5: ERROR WARN INFO DEBUG
 0                  20 22   27 28
```

Offsets are fixed, which is why `levelOf()` indexes them directly instead of running a
regex. **The level is authoritative**: only `ERROR` lines may change the reported status.
Keyword sniffing (`failed to`, `fatal`, …) applies only to `ERROR` lines and to lines that
are not applog output at all (wrapper messages). Without that rule, upstream's ordinary
`DEBUG Failed to get Stratum session id` reports a crash on a perfectly healthy rig.

| Value | Format | Source |
|---|---|---|
| Share result | `accepted: A/B (P%), total hashrate: N.NN kH/s` or `(pending...)` | `main.cpp:740` |
| Per-device | `cu_device(W):[ err:N,][ temp:NC,][ power:NW,][ fan:N%,] hashrate: N.NN kH/s` | `main.cpp:3177` |
| Difficulty | `Stratum difficulty set to %g` (may be `1e-05`) | `Util.cpp:1523` |
| Protocol dump | `> {json}` / `< {json}` at `DEBUG` (needs `--protocol-dump`) | `Util.cpp:1014/1137` |
| Device list | `\tIndex: N. Name: X. pcieId: bb:dd:f` on **stdout** | `main.cpp:4744` |
| Worker banner | `Configured N(CL) and M(CUDA) workers` | `main.cpp:5959` |

`B` in the share line is `accepted + rejected`, so `rejected = B - A`. `total hashrate` is
the instantaneous sum of the per-thread rates — which is why the dashboard's total is a
plain sum and never an average.

**`cu_device(W)` prints the worker slot, not the device index**
(`cuWorkerIndex = threadInfo->id - cuDeviceIndexOffset`, `main.cpp:2649`). They coincide
only with `--all-cu-devices`. `config.DEVICE_SELECTION` carries the worker→device map for
`--cu-devices 1,3`.

## Data-integrity invariants

* **Every state mutation sets `state.dirty`.** The SSE hub refuses to serialise when the
  state is clean, so a mutation that forgets the flag is invisible to the browser. This bit
  the `mining.set_difficulty` path, which updates state without ever logging a line.
  *(test: "every state mutation marks the snapshot dirty")*
* **The rig total is only published once every configured worker has reported.**
  `expectedWorkers` comes from the miner's own banner; the fallback heuristic ("a device
  reported twice") only applies when the banner was missed.
  *(test: "partial device coverage never reports a partial rig total")*
* **`_resetStats()` must clear `seenDevices` and `expectedWorkers`.** Leaving them set makes
  the first device line after a restart look like a complete rig.
  *(test: "the total hashrate is correct again after a restart")*
* **The total is recomputed, never adjusted.** Incremental `total - old + new` accumulates
  float error and desynchronises permanently if one line is missed.
* **PCI ids are parsed from the right.** nvidia-smi says `00000000:01:00.0`, the miner says
  `01:00:0`; both must collapse to `01:00:0` or telemetry lands on the wrong card. One
  `normalizePci()` serves both sides deliberately.
* **A live status is downgraded when the process is gone.** `effectiveStatus()` turns
  `MINING` into `STOPPED` when `miner.running` is false, so the pill can never lie.

## Process supervision

* `start()` resolves **after** the spawn attempt, so callers have a defined point at which
  `state.miner` is authoritative.
* The `--device-list` probe always calls back exactly once — on close, on error, or on the
  watchdog. A hung probe must never be able to prevent mining.
* `child.killed` only means "a signal was delivered". Escalation to `SIGKILL` is driven by
  `exitCode`/`signalCode`; using `killed` makes the escalation dead code.
* `exit` fires before `close`. Both are bound to one idempotent handler, because `stop()`
  clears `this.proc` on the first of them, and a `this.proc !== child` guard would then skip
  the state reset entirely.
* An unrequested death **by signal** is a crash. `code === null` alone is not a clean exit.
* A bare `MINER_EXE` is resolved against `MINER_CWD` before falling back to `PATH`: Windows'
  `CreateProcess` searches the working directory, POSIX' `execvp` does not.
* On Windows the dashboard drops itself to below-normal priority and explicitly restores the
  spawned miner to normal, so supervision never competes with hashing.

## Streaming and back-pressure

* SSE frames carry **only new console lines**. `logsFrom`/`logSeq`/`logCount`/`logCapacity`
  let the browser append by id and trim like the server's ring buffer.
* `CircularLogBuffer.since()` returns the **entire retained buffer** when the consumer has
  fallen behind the retention window. That single rule is what makes deltas safe: a client
  can be slow, stalled, or reconnecting and still cannot end up with a hole.
  *(tests: "every delta chain reconstructs the full log exactly once",
  "a client that missed frames is resynchronised, never left with a hole")*
* A client whose socket does not drain is skipped, not buffered; after
  `SSE_MAX_BLOCKED_TICKS` skips it is dropped. Slow clients cost memory, and memory here
  belongs to the miner.
* One heartbeat interval serves the whole hub. Per-client intervals leak whenever a
  connection is reaped by anything other than its own `close` event.
* Broadcasts are coalesced into one serialisation per window and shared by every client with
  the same cursor (at most `MAX_SSE_CLIENTS` distinct payloads, normally one).

## Zero-idle contract

Nothing scales with time while nobody is watching:

| Gate | Effect |
|---|---|
| `onSubscriberChange(0)` | GPU polling stops, log fan-out stops, heartbeat cleared |
| Client `visibilitychange` | a hidden tab drops its stream, returning the server to idle |
| Global GPU cooldown | reconnects and extra clients cannot amplify `nvidia-smi` spawns |
| Consecutive-failure backoff | a missing driver decays to a 2-minute retry instead of 5s |
| Telemetry change detection | an identical sample produces no frame at all |

Miner output **is** parsed while idle (1.5–2.5 µs/line). Skipping it would leave a client
that attaches later reading stale counters; the cost is far below the noise floor.

## HTTP layer

* Static assets are read, hashed and gzipped **once at boot**. Requests do zero I/O and zero
  compression work; `If-None-Match` short-circuits to `304`.
* Nothing concatenates a request path with a filesystem path — traversal is structurally
  impossible rather than filtered.
* Routes live in a `Map`. A plain object resolves `GET /constructor` through
  `Object.prototype` and calls a non-handler.
* State-changing requests need `X-Requested-With: XMLHttpRequest` **and** a same-origin
  `Origin` when one is present. Browsers cannot forge either cross-origin without a CORS
  preflight that is never answered.
* `readJsonBody` answers `413` before hanging up; destroying the socket first turns a clear
  error into `ECONNRESET` in the client's console.
* Session cookies are `HttpOnly; SameSite=Strict`. `Secure` is *not* set, because the
  documented deployment is plain HTTP on a LAN; the cookie helper takes a flag for
  deployments behind TLS.
* `frame-ancestors` is intentionally absent from the CSP: `SameSite=Strict` already makes a
  framed copy useless to an attacker, and omitting it keeps the page embeddable.

## Browser layer

* `public/js/present.js` is the **only** place a snapshot becomes display text. The browser
  and the test suite share it, so an assertion about "what the UI shows" cannot drift from
  what is painted.
* Console text is escaped **before** highlighting, and highlighting is skipped entirely for
  lines over 512 characters.
* `public/js/perf.js` decides how expensive the page is allowed to be. The page starts in
  the cheap mode and only adds `class="fx"` (backdrop blur, large shadows, infinite
  animations) when the device proves it can afford it — measured by frame timing, or assumed
  from `deviceMemory`/`hardwareConcurrency`. Starting cheap means a weak tablet never paints
  an expensive frame at all, and `prefers-reduced-motion` / `update: slow` keep it cheap
  permanently.
* Layout stability: every element whose text changes at runtime has a reserved width; the
  GPU panel renders a skeleton card so real telemetry does not displace the panel below it;
  the error box is the last node in its panel so showing it moves nothing.
  *(test: "layout-stability reservations are present for every element that changes text")*
