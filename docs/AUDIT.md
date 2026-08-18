# Audit, Hardening & Test-Suite Report

_Repository:_ `brittojo7n/VerthashMiner-Dashboard`
_Branch:_ `arena/01a01688-verthashminer-dashboard`
_Scope:_ log↔UI data integrity, security, resource usage, resilience, test coverage
_Reference config:_ `PORT=4067`, `HOST=0.0.0.0`, `FORWARD_CONSOLE=true`, zpool VTC stratum,
`--all-cu-devices`

---

## 0. How the log formats were verified

Every parsing rule was checked against the **upstream VerthashMiner sources**
(`CryptoGraphics/VerthashMiner`, branch `main`), not against assumptions:

| Data | Upstream location | Format |
|---|---|---|
| Log envelope | `src/vhCore/Util.cpp:88` | `[%d-%02d-%02d %02d:%02d:%02d] %-5s %s` (stderr) |
| Levels | `src/vhCore/Util.cpp:61` | `ERROR`, `WARN`, `INFO`, `DEBUG` |
| Share result | `src/main.cpp:740` | `accepted: %lu/%lu (%.2f%%), total hashrate: %s` |
| Per-device rate | `src/main.cpp:3177` / `:2177` | `cu_device(%d):[ err:N,][ temp:NC,][ power:NW,][ fan:N%,] hashrate: %.02f kH/s` |
| Difficulty | `src/vhCore/Util.cpp:1523` | `Stratum difficulty set to %g` |
| Protocol dump | `src/vhCore/Util.cpp:1014/1137` | `> %s` / `< %s` at `DEBUG` |
| Device list | `src/main.cpp:4744` | `\tIndex: %u. Name: %s. pcieId: %02x:%02x:0` |
| Worker banner | `src/main.cpp:5959` | `Configured %llu(CL) and %llu(CUDA) workers` |
| Pool failures | `src/main.cpp:3767/3777`, `Util.cpp:1225/1082/1116/1416` | see §1.2 |

The important consequence: `accepted: A/B` means **A accepted / B submitted**, and
`total hashrate` is the *sum of the per-thread rates at that instant*. The dashboard now
mirrors both definitions exactly.

---

## 1. Correctness / data-integrity defects found and fixed

### 1.1 `DEBUG`/`INFO` lines could fake a crash — **fixed**

`classifyLine()` keyword-sniffed every line for `failed to`, so upstream's routine
`[…] DEBUG Failed to get Stratum session id` (emitted by most pools, `Util.cpp:1334`)
flipped the dashboard to **CRASHED** and raised a red "CRITICAL ERROR" box while the rig
kept hashing. `JSON decode failed`, `stale work detected` and similar informational lines
were in the same class.

*Fix:* the applog level is now parsed from its fixed offset and treated as authoritative.
Only `ERROR` lines can be terminal; `INFO`/`DEBUG` never are. Regression corpus:
`test/unit/parser.test.js` → *"classifyLine() never marks INFO/DEBUG output as fatal"*.

### 1.2 Half the pool-disconnect messages were not recognised — **fixed**

Only three phrasings were detected. Upstream emits at least eight, none of which contain a
generic fatal keyword, so the dashboard kept displaying **MINING** with a frozen hashrate
while the pool link was gone:

`stratum_recv_line timed out`, `stratum_recv_line failed`, `Stratum authentication failed`,
`submit_upstream_work stratum_send_line failed`, `stratum thread create failed`,
`json_rpc_call failed, retry after N seconds` (GBT mode).

*Fix:* `RX_POOL_DOWN` now covers all of them → status `DISCONNECTED`. Verified for all 11
fatal variants in `test/unit/parser.test.js`.

### 1.3 Silent state updates never reached the browser — **fixed**

`parseMinerLine()` mutated `state.mining` but only `state.dirty` gated the SSE fan-out, and
`dirty` was set exclusively by `pushLog()`. Protocol-dump frames (`mining.set_difficulty`)
are deliberately *not* logged, so **a difficulty change updated the server but was not
broadcast** until some unrelated line happened to be logged.

*Fix:* every mutation sets `state.dirty`. Test: *"every state mutation marks the snapshot dirty"*.

### 1.4 Total hashrate drifted and could show a partial rig — **fixed**

Two problems in the same block:

* the total was maintained incrementally (`total - old + new`), so it accumulated floating
  point error over a long session and permanently desynchronised if a single device line
  was missed;
* readiness was heuristic ("a device reported twice"), and `seenDevices` was **not** cleared
  by `_resetStats()`. After a restart the first device line satisfied the heuristic
  immediately, so a **2-GPU rig displayed a single GPU's hashrate as the rig total**.

*Fix:* the total is recomputed as an exact sum; the worker count is read from the miner's
own banner (`Configured 0(CL) and 2(CUDA) workers` / `N miner threads started`), so
"all devices reported" is now a fact, not a guess; `seenDevices`/`expectedWorkers` reset on
every start. Tests: *"total hashrate is the exact sum … (no drift)"*,
*"partial device coverage never reports a partial rig total"*,
*"the total hashrate is correct again after a restart"*.

### 1.5 Two different PCI normalisers → possible wrong GPU attribution — **fixed**

`devices.normalizePci()` and the regex inside `gpu.js` disagreed:
`normalizePci("00000000:01:00.0")` returned **`00:01:0`** (it matched the domain prefix),
while `gpu.js` returned `01:00:0`. Today only miner-formatted ids reach the first function,
so production output was correct — but the two sides of a join key were computed by two
different rules, which is a latent mis-attribution bug.

*Fix:* one shared `normalizePci()` that parses from the right-hand side; `gpu.js` imports it.
Found by test, covered by *"PCI ids from both tools normalise to the same key"*.

### 1.6 Device subsets mapped hashrates to the wrong GPU — **fixed**

`cu_device(N)` prints the **worker slot**, not the CUDA device index
(`cuWorkerIndex = threadInfo->id - cuDeviceIndexOffset`, `main.cpp:2649`). With
`--cu-devices 1,3`, worker 0 is device 1, so the telemetry card for GPU 1 showed GPU 3's
hashrate. (`--all-cu-devices`, as in the reference config, is unaffected.)

*Fix:* `config.DEVICE_SELECTION` builds a worker→device map that the parser applies.
Test: *"device subsets map worker slots back to device indices"*.

### 1.7 `exit`/`close` race skipped the shutdown bookkeeping — **fixed** _(introduced during this work, caught by tests)_

`stop()` nulls `this.proc` on `exit`, while the spawn handler guarded on
`this.proc !== child` and ran on `close` — which fires **after** `exit`. The result was a
skipped `_markDown()`: counters were not reset, `exitCode`/`signal` were not recorded and no
`Exited (code: …)` line appeared. Now a single `onGone` handler is bound to both events and
is idempotent.

### 1.8 A signal-killed miner was reported as a clean stop — **fixed**

`code === 0 || code === null → STOPPED` treated `SIGKILL` (`code: null, signal: 'SIGKILL'`)
as a graceful exit. An externally killed miner now reports **CRASHED**.
Test: *"the miner being SIGKILLed out from under us is reported, not fatal"*.

---

## 2. Resilience / failsafe defects

| # | Defect | Impact | Fix |
|---|---|---|---|
| 2.1 | **`--device-list` probe had no timeout** — `done()` was only called on `close`/`error` | A hung probe wedged the miner start **forever**; the UI sat at `STARTING` with no miner | 8 s watchdog kills the probe, logs why PCI mapping is missing, and starts the miner anyway |
| 2.2 | **SIGKILL escalation never fired** — `if (!child.killed) child.kill("SIGKILL")`; `killed` is already `true` after the SIGINT | A miner ignoring SIGINT was never force-killed; `stop()` never resolved; shutdown hung indefinitely | Escalation is driven by `exitCode`/`signalCode`; measured stop time for an unkillable-by-SIGINT miner dropped from **∞ → 2.4 s** |
| 2.3 | **No ceiling on `stop()`** | `server.stop()` awaited it before exiting | 10 s stop watchdog + 12 s process shutdown watchdog |
| 2.4 | **Windows `taskkill` result ignored, no fallback timer** | If `taskkill` failed, the promise never settled | Callback + force-kill timer on both platforms |
| 2.5 | **No `uncaughtException`/`unhandledRejection` handling** | Any dashboard bug killed the supervisor and orphaned the miner | Contained fault handler: logs, surfaces the error in the UI console, keeps mining |
| 2.6 | **Listen failures were swallowed** (only `EADDRINUSE` handled) | `EACCES` left an invisible process running with no HTTP server | Any bind failure is fatal with a clear message; `EADDRINUSE` names the likely cause |
| 2.7 | **Stream reader discarded complete lines on overflow** | A burst >64 KB in one chunk dropped whole log lines | Complete lines are always emitted; only an unterminated partial line is capped |
| 2.8 | **Parser exceptions were unguarded** | A malformed line could throw inside a `data` handler | Parse is wrapped; a fault degrades one line, not the process |
| 2.9 | **Bare `MINER_EXE` was not resolved against `MINER_CWD`** | Works on Windows (CreateProcess searches CWD), fails with `ENOENT` on Linux | `resolveExe()` resolves a bare name against `MINER_CWD`, then falls back to `PATH` |

---

## 3. Security review

### 3.1 Confirmed sound (no change needed)

* **No command injection** — `spawn()` with an argument array, `shell: false`; the action
  name is matched against a `Set` allow-list.
* **No path traversal** — the whole `public/` tree is read into memory at boot; a request
  path is *never* concatenated with a filesystem path. Verified with 9 traversal probes.
* **No XSS** — console text is HTML-escaped **before** highlighting; all other values go
  through `textContent`. Enforced by a source-level test.
* **Timing-safe passphrase comparison**, HMAC-derived 256-bit session tokens,
  `HttpOnly; SameSite=Strict` cookies, per-IP lockout.

### 3.2 Weaknesses found and fixed

| # | Issue | Fix |
|---|---|---|
| 3.2.1 | **Cookie regex not anchored** — `/vm_session=([0-9a-f]+)/` matched inside another cookie's *value* | Anchored to a cookie boundary with a length bound |
| 3.2.2 | **`MAX_SESSIONS` was never enforced** — `prune()` only dropped *expired* tokens, so a valid passphrase could grow the map without bound | Hard cap with oldest-first eviction |
| 3.2.3 | **Route table was a plain object** — `GET /constructor` resolved through `Object.prototype` and invoked a non-handler | Routes are a `Map`; verified for `constructor`, `__proto__`, `toString`, `hasOwnProperty` |
| 3.2.4 | **CSRF relied on a custom header alone** | Added a same-origin `Origin` check on every state-changing request |
| 3.2.5 | **Oversized bodies were answered with a socket reset** | Bounded read now answers `413` before closing |
| 3.2.6 | **No slow-loris protection** | `headersTimeout` 20 s, `requestTimeout` 30 s, `keepAliveTimeout` 5 s, `maxHeadersCount` 64, `clientError` → `400` |
| 3.2.7 | **CSP was minimal** | Added `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `Referrer-Policy: no-referrer`, `Permissions-Policy` |
| 3.2.8 | **Symlinks inside `public/` were served** | Only regular files are cached |
| 3.2.9 | **No login flood limiter besides lockout** | Added a 10 req/10 s limiter in front of the lockout logic |
| 3.2.10 | **Weak secrets accepted silently** | Boot-time advisories for short `SESSION_SECRET`/`PASSPHRASE` and for LAN-exposed plain HTTP |

### 3.3 Accepted residual risks (documented, not "fixed")

* **Plain HTTP.** With `HOST=0.0.0.0` the passphrase and session cookie cross the LAN in
  clear text. Adding TLS would mean shipping certificate management into a zero-dependency
  tool; the correct answer is a reverse proxy. The boot advisory now says so explicitly.
* **`frame-ancestors` is deliberately absent.** The session cookie is `SameSite=Strict`, so a
  cross-site frame is always logged out and cannot be used for clickjacking; keeping the page
  embeddable is worth more than a directive that adds nothing here.
* **`style-src 'unsafe-inline'` retained** because the Google Fonts stylesheet is loaded
  cross-origin. No inline `<style>` or `style=` attribute exists in the markup (test-enforced),
  so the practical exposure is nil.

---

## 4. Performance work

### 4.1 Measured (this environment: Node v22, Linux container, mock miner)

| Metric | Value | How |
|---|---|---|
| Parser throughput | **5.06 µs/line** (50 000 lines in 253 ms) | `test/stress/resources.test.js` |
| Idle CPU (miner streaming, **no browser attached**) | **0.021 %** | same |
| Active CPU (server + SSE client in one process) | **0.16 %** | same |
| Dashboard RSS (live, one client, mock miner attached) | **55.9 MB** (≈40 MB is the Node runtime) | `ps` on the live process |
| Heap growth over 20 000 parsed lines | **≈0 MB** (ring buffer bounded) | same |
| Firehose: 32 472 lines in 3 s | 4.2 % CPU, **heap +0.1 MB**, server responsive | same |
| Storm of 200 concurrent `/api/status` | 3 served, 197 throttled, 223 ms, no queue build-up | same |
| nvidia-smi spawns with 3 clients over 1.5 s | **1** | same |

### 4.2 Optimisations implemented

1. **Incremental console delivery.** Each SSE frame previously re-sent the entire log ring
   buffer. Frames now carry only new entries (`logsFrom`/`logSeq`/`logCount`/`logCapacity`).
   * Default `MAX_LOGS=50`: **6 830 B → 800 B per frame (8.5×)**, serialisation
     **0.0156 ms → 0.0064 ms (2.4×)**.
   * `MAX_LOGS=500`: **62 394 B → 551 B (113×)**.
   * Integrity is preserved by construction: `since()` returns the *whole retained buffer*
     whenever a consumer has fallen behind, and a back-pressured client is resynchronised on
     its next successful write. Tests prove "no gaps, no duplicates" over 200 lines and
     across a stall/drain cycle.
2. **One heartbeat timer for the whole hub** instead of one `setInterval` per client — and,
   more importantly, a reaped client can no longer leave a stray timer writing to a dead
   socket every 15 s.
3. **Change detection for GPU telemetry.** An identical `nvidia-smi` sample no longer marks
   the state dirty, so a static rig produces no SSE traffic between real changes.
4. **Backoff for a broken `nvidia-smi`.** A missing driver used to spawn a doomed process
   every 5 s forever; the interval now grows to a 2-minute ceiling and the error is reported
   once instead of on every poll.
5. **Cheaper stream reading** — index-based line splitting instead of a regex `split()` per
   chunk, with `setEncoding("utf8")` so chunks are not re-decoded.
6. **Snapshot projection** builds a flat object per GPU instead of spreading the source
   object, and skips array allocations for empty deltas.
7. **All internal timers are `unref()`ed**, so no dashboard timer can keep the process alive
   during shutdown.

### 4.3 GPU usage: zero, by construction

The backend never links, loads or initialises CUDA/OpenCL/NVML. Its *only* GPU-adjacent
action is `execFile("nvidia-smi", ["--query-gpu=…", "--format=csv,noheader,nounits"])`, a
read-only driver query that creates no device context and allocates no VRAM. A test asserts
the argument vector stays read-only (no `-l/--loop`, `-pm`, `--gpu-reset`, `-ac`, …), and the
UI-asset test guarantees the browser bundle has no WebGL/WebGPU usage. Any VRAM you see
belongs to the miner.

### 4.4 Documentation corrected

The README claimed "no regex work on miner output while idle". That was **not true**: lines
were always parsed; only *log fan-out* was gated. Rather than sacrifice accuracy (skipping
parsing would leave stale counters for a client that attaches later), parsing is kept and
the README now states the measured cost (5 µs/line ⇒ well under 0.01 % CPU at real log rates).

---

## 5. Review of the external ("Kilo") report

| Kilo claim | Verdict | Detail |
|---|---|---|
| Mining stability, no dashboard-caused kills, no page errors, lightweight, no severe vulnerabilities | **Consistent with my findings** | Reproduced structurally; no crash paths found in the supervisor |
| UI ↔ console accuracy "perfect match" | **Too optimistic** | Correct for a healthy single-run, all-GPU session — which is what a 60 s observation covers. It cannot catch §1.1, §1.2, §1.4, §1.6, which need a `DEBUG Failed to…` line, a pool drop, a restart, or a device subset |
| CLS = 0.35 (poor) | **Plausible, not reproducible here** | This is a Linux container with no browser; I could not measure CLS. The *causes* are verifiable in the source, so I fixed those structurally (§6) |
| Fix: `min-height` on `.errorbox` / `.errorbox.show` | **Would not have worked** | The box toggles `display:none → block`. Adding `min-height` to a `display:none` element reserves nothing; the console is pushed down by exactly as much as before |
| Fix: `.status { min-width: 140px }` | **Right idea** | Applied to the `#status` text span (108 px) so the dot stays left-aligned; also covers `RECONNECTING`, which is the longest string |
| Fix: `.panel.wide { min-height: 120px }` | **Ineffective** | A GPU card is ~370 px tall; 120 px reserves nothing useful, and both wide panels share the class |
| Fix: `.wallet-addr { overflow/ellipsis/nowrap }` | **Already present** | `public/style.css:309-319`, plus `.min-w-0` on the parent |
| Root cause attribution `.panel.wide.glass-panel → 0.3210` | **Misattributed** | Both wide panels carry that class. The dominant shift is the *GPU panel* growing from a one-line notice to full cards, which displaces the entire Mining Metrics panel below it — not the error box |

---

## 6. Layout-stability (CLS) fixes actually applied

1. **Skeleton GPU card.** Before the first `nvidia-smi` sample the panel renders a real card
   with `—` placeholders instead of a one-line "Waiting…" notice, so telemetry arriving does
   not push the Mining Metrics panel down. This addresses the largest shift.
2. **Error box moved below the console** (`public/index.html`). It is now the last node in the
   panel: showing it grows the panel downwards and displaces nothing. Also given
   `role="alert"`.
3. **Reserved widths for every element whose text changes at runtime** —
   `#status` (108 px, fits `RECONNECTING`/`DISCONNECTED`), `#btnAction`/`#btnRestart` (78 px,
   `START`↔`STOP`), `#btnAutoScroll` (112 px, `ON`↔`OFF`), `.console-counter` (58 px,
   `0 logs`→`500 logs`).
4. **`font-variant-numeric: tabular-nums`** on the hashrate, uptime, clock and last-share
   values so digit changes cannot re-flow their rows.
5. **`.gpu-empty` given a 180 px min-height** so the skeleton→error transition is small.
6. A test asserts each reservation still exists (`test/unit/ui-assets.test.js`).

**Not fixed, and worth knowing:** the Google Fonts stylesheet loads with `display=swap`,
so the fallback→Outfit swap re-flows text once. Self-hosting the two fonts (or dropping the
web font) is the only real cure; it is a deliberate design trade-off, so it is left alone and
documented here.

---

## 7. Test suite

168 tests, zero dependencies, `node --test` only. See `docs/TESTING.md`.

```
test/unit/         104  parser, state/ring-buffer, devices, gpu, sse, auth, ratelimit,
                        config, present (UI projection), ui-assets
test/integration/   40  http surface, end-to-end accuracy, lifecycle, browser render,
                        env setup
test/failure/       14  crashes, kills, hangs, garbage, malformed HTTP, boot gates
test/stress/        10  throughput, memory, idle/active CPU, floods, storms
```

The accuracy layer is the important one. It works as a **differential test**:

```
canonical console corpus ──► src/parser.js ──► state ──► SSE/HTTP ──► public/js/present.js
         │                                                                    │
         └────────────────► test/helpers/oracle.js (independent) ──────────────┴──► assert equal
```

`oracle.js` shares no code with the parser — it re-derives every metric with plain string
operations — so agreement is evidence, not tautology. The comparison runs over every prefix
of the session (27 checkpoints), through a real child process, and finally against the exact
strings `present.js` puts on screen.

`public/js/present.js` was extracted for this purpose: the browser and the tests now use the
same projection, so a rendering change cannot silently escape the assertions.

---

## 8. What I could not verify here (be aware)

This sandbox is Linux, has **no NVIDIA GPU, no `nvidia-smi`, no Windows and no real
VerthashMiner binary**, and no browser engine. Consequently:

* `nvidia-smi` parsing is verified against *recorded* CSV output, not a live driver.
* The Windows `taskkill.exe` stop path is code-reviewed and unit-shaped, but exercised on
  POSIX signals here.
* CLS is addressed structurally; **re-measure it in DevTools on the real rig** to confirm the
  0.35 → <0.10 improvement.
* A real `verthash.dat` (~1.2 GB, blockchain-derived) cannot be produced by this repository.
  `tools/setup-test-env.js` writes a clearly-labelled 1 MB placeholder for path/plumbing
  tests; the real file must come from `VerthashMiner --gen-verthash-data verthash.dat`.

Nothing in this report is inferred from a metric I did not actually run.
