# Test harness

Everything here is dev-only: the dashboard itself still ships with zero
dependencies and no build step.

```
test/
  run-all.sh              full sweep: unit + e2e (+ browser with --all)
  unit/                   node:test suites for every src/ module and the
                          browser-side pure modules (parser, state, gpu, sse,
                          auth, ratelimit, config, miner lifecycle, present,
                          perf gate)
  e2e/run-e2e.js          boots the REAL server with a mock VerthashMiner child
                          process and a mock nvidia-smi on PATH; verifies SSE,
                          rate limits, auth/CSRF/lockout, miner control API,
                          zero-idle gating, crash/pool-outage paths, and
                          cross-checks console lines against derived metrics
  browser/                dev-only puppeteer harness (npm install inside)
    fps.js                emulates a 4GB/quad-core tablet (CPU throttling +
                          software compositing) and measures frame rates while
                          the dashboard streams live data; proves the perf gate
                          decision ladder and the governor self-heal path
    visual.js             pixel-diffs the old vs new client at the desktop fx
                          tier on deterministic frozen data (visuals unchanged)
  mocks/
    miner-mock.js         VerthashMiner emulator speaking the exact log contract
                          the parser is built against (modes: healthy, pooldown,
                          rejects, memerr, crash, flood, quiet, silent, visual)
    miner                 wrapper used as MINER_EXE (routes --device-list)
    bin/nvidia-smi        CSV telemetry mock (modes: ok, static, fail, empty,
                          garbage; optional MOCK_SMI_LOG spawn counter)
```

## Running

```bash
test/run-all.sh            # unit + e2e — no dependencies, works everywhere
test/run-all.sh --all      # + browser harness
```

The browser harness needs a one-time install (it vendors a private Chromium via
npm so nothing touches your system browser):

```bash
cd test/browser && npm install
node fps.js && node visual.js
```
