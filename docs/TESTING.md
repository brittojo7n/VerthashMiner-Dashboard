# Testing Guide

168 tests, **zero dependencies**, no build step. Everything runs on Node's built-in test
runner (`node --test`, Node 18.2+; 20+ recommended).

```bash
npm test              # unit + integration + failure   (~25 s)
npm run test:unit     # pure logic, no sockets, no processes
npm run test:integration
npm run test:failure  # crash / kill / hang / garbage-input scenarios
npm run test:stress   # throughput, memory and CPU budgets (~12 s)
npm run test:all      # everything, with --expose-gc for accurate heap deltas
```

---

## Why the suite is built this way

The dashboard's contract is a single sentence: **what the browser shows must equal what the
miner printed.** A test that reuses the parser to compute the expected value proves nothing,
so accuracy is verified *differentially*:

```
        canonical console corpus (test/helpers/fixtures.js)
                       │
        ┌──────────────┴───────────────┐
        ▼                              ▼
  src/parser.js                 test/helpers/oracle.js
  src/state.js                  (independent re-derivation:
  src/sse.js  / src/http.js      plain string ops, no shared code)
  public/js/present.js
        │                              │
        └────────── assert equal ──────┘
```

* **`fixtures.js`** – the corpus. Every line matches a real upstream `printf`
  (file/line references are in the file header, cross-checked against
  `CryptoGraphics/VerthashMiner@main`).
* **`oracle.js`** – reads the same lines and computes accepted/submitted/rejected/difficulty/
  hashrate/status using deliberately naive code. If the parser and the oracle agree, both are
  almost certainly right; if they disagree, one of them is wrong and the diff says which.
* **`public/js/present.js`** – the snapshot→string projection the *browser itself* uses.
  Testing it means testing the rendered text, not an approximation of it.

The comparison is run three ways: on the final state, on **every prefix** of the session
(27 checkpoints, catching order-dependent bugs), and end-to-end through a real child process
and a real SSE socket.

---

## Layout

```
test/
  helpers/
    fixtures.js      canonical corpus + generators + hostile inputs
    oracle.js        independent metric reduction (the differential reference)
    harness.js       boots the full stack on an ephemeral port; HTTP + SSE clients
    dom-stub.js      minimal DOM + EventSource so public/js/app.js can run in Node
  mocks/
    mock-miner.js    executable VerthashMiner stand-in with failure modes
  unit/              parser, state, devices, gpu, sse, auth, ratelimit, config,
                     present, ui-assets
  integration/       http, accuracy (end-to-end), lifecycle, browser-render, setup-env
  failure/           failure-modes: crashes, SIGKILL, hangs, garbage, bad HTTP, boot gates
  stress/            resources: throughput, heap, CPU, floods, request storms
```

### The mock miner

`test/mocks/mock-miner.js` is executable (shebang) so the `--device-list` probe — which is
spawned *without* `MINER_ARGS` — also reaches it. Behaviour is selected with
`MOCK_MINER_MODE` (the harness sets and restores it):

| Mode | Behaviour | Exercises |
|---|---|---|
| `session` (default) | replays the canonical corpus once, then idles | accuracy, console ordering |
| `loop` | replays forever | long-running UI, live preview |
| `crash` | emits, then `exit(1)` | CRASHED status, exit reporting |
| `instant` | `exit(1)` immediately | spawn-time failure |
| `hang` | ignores SIGINT/SIGTERM | force-kill escalation, stop watchdog |
| `probehang` | hangs only on `--device-list` | probe watchdog |
| `probefail` | fails the probe | degradation to positional GPU mapping |
| `flood` | thousands of lines as fast as possible | back-pressure, coalescing, heap |
| `nonewline` | megabytes with no `\n` | unterminated-line cap |
| `binary` | invalid UTF-8 and control bytes | parser robustness |

### The harness

```js
const app = await startServer({
  env:      { PASSPHRASE: "pw", MAX_LOGS: "15" },  // .env-equivalent overrides
  mock:     { mode: "crash", intervalMs: 1 },      // mock miner behaviour
  smi:      (bin, args, opts, cb) => cb(null, CSV),// stubbed nvidia-smi
  timeouts: { probe: 800 }                         // shortened watchdogs
});
```

`app.close()` stops the GPU poller, closes every stream, stops the miner, disposes timers,
closes the server and restores the environment — so a leaked handle fails the run instead of
hiding in it.

`nvidia-smi` is **always stubbed**; the suite never shells out to a real driver tool, and by
default the stub reports `ENOENT` so the "no NVIDIA driver" path is the default path.

---

## What each tier guarantees

**Unit** — parser semantics against the upstream formats (levels, fatal vs informational,
pool-down phrasings, difficulty incl. scientific notation, share counting, reject reasons,
per-device totals, worker→device mapping); ring-buffer/delta algebra; PCI normalisation;
chunk→line reassembly; nvidia-smi CSV; SSE fan-out (deltas, resync after back-pressure, client
cap, single heartbeat, coalescing); sessions (forgery, expiry, caps, lockout, timing);
rate-limiter windows; config parsing/clamping/security gates; the browser projection; and
static asset/CSP invariants.

**Integration** — the HTTP surface (auth, CSRF, traversal, prototype pollution, 413, 429,
HEAD, CSP headers), the end-to-end accuracy chain, the miner lifecycle (start/stop/restart,
double-click protection, counter reset, crash, missing binary, hung probe), the generated
test environment, and a **browser-render** test that executes the real `public/js/app.js`
against a live server through a stub DOM and asserts the text it writes into each element
(including that hiding the tab drops the subscription and stops GPU polling).

**Failure** — externally SIGKILLed miner, garbage bytes, no-newline flood, missing/hanging/
truncated `nvidia-smi`, abandoned and half-open sockets, non-HTTP garbage, oversized headers,
a fault thrown inside a dashboard callback (the miner must survive it), refusal to boot with
an insecure config, prompt SIGTERM shutdown, and port-conflict diagnostics.

**Stress** — budgets that fail the build if they regress: parser ≤10 µs/line, idle CPU <5 %,
active CPU <25 % (measured for the whole test process, which also hosts the SSE client), heap
growth bounds under floods and reconnect cycles, delta payload ≥5× smaller than a full frame,
and at most one `nvidia-smi` spawn per interval regardless of client count.

---

## Building a runnable environment

```bash
npm run setup:testenv          # writes .testenv/ (git-ignored)
ENV_FILE=.testenv/.env node server.js
```

This produces the supplied deployment configuration (port 4067, `0.0.0.0`, passphrase,
zpool stratum URL, wallet, `--all-cu-devices`) with a freshly generated 64-character
`SESSION_SECRET`, an executable miner stand-in, and a **placeholder** `verthash.dat`.

> The placeholder is a deterministic 1 MB file. It is *not* a valid Verthash data file and
> the real miner will reject it. The genuine ~1.2 GB file is derived from the Vertcoin
> blockchain and can only be produced by the miner itself:
> `VerthashMiner --gen-verthash-data verthash.dat`.

---

## Adding tests

* Put new console formats in `test/helpers/fixtures.js` **and** teach `oracle.js` to read
  them — never teach the oracle by copying parser code.
* Prefer `startServer()` over hand-rolled servers so cleanup stays centralised.
* Give every wait a timeout (`client.waitFor(pred, ms)`); never poll with bare `delay()`.
* Keep stress thresholds generous enough for a loaded CI box but tight enough to catch an
  order-of-magnitude regression.
