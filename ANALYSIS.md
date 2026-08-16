# VerthashMiner Dashboard — Architecture & Engineering Analysis

> **Status: resolved.** This document records the original investigation at commit
> `1f3bb87`. Every defect listed here has since been fixed and covered by tests
> (`./test/all.sh`). File paths referring to `public/script.js` predate the split
> into `public/js/*`. Kept for the rationale behind each change.

_Analysis of commit `1f3bb87`. Findings marked **[verified]** were reproduced by running the code._

---

## 1. What this project actually is

A **single-purpose, zero-dependency Node.js supervisor + web UI** that wraps
[VerthashMiner](https://github.com/CryptoGraphics/VerthashMiner) (Vertcoin/VTC GPU miner) on Windows.

It is **not** a mining pool, not a multi-rig fleet manager, and not a general process manager. It is a
*sidecar for one miner process on one machine*, viewed by one person (or a couple of tabs) on a LAN.

### The core value proposition
The README's phrase "zero-overhead" is the actual product thesis, and it is architecturally enforced:

> **Every watt spent on the dashboard is a watt not spent hashing.**

The whole design follows from that constraint:

| Mechanism | Effect |
|---|---|
| `nvidia-smi` polling only while an SSE client is attached (`GpuManager.updateSubscribers`) | No `execFile` spawns when nobody is watching |
| Log **parsing** disabled when no client attached (`MinerManager.disableParsing`) | No regex work on miner stdout at idle |
| Poll interval clamped 3–10 s + global cooldown (`_cooldownLeft`) | Refresh/reconnect/N clients cannot amplify spawns |
| `FORWARD_CONSOLE=false` default | No stdout write syscalls at idle |
| Static assets read into memory once at boot (`loadStaticCache`) | Zero disk I/O per request |
| Client closes the `EventSource` on `visibilitychange` | Hidden tab → server drops to true idle |

That last one is the keystone: **the browser tab is the on/off switch for all server-side work.**
Any future change must preserve this invariant.

### Runtime topology

```
launch.bat (Admin)
   └── node server.js ─────────────────── Server (server.js, orchestrator/DI root)
         ├── config.js      hand-rolled .env parser + fail-fast security gates
         ├── MinerManager   spawn(VerthashMiner.exe) ── stdout/stderr ──┐
         │     └─ pre-flight spawn(--device-list) → PCI→CUDA index map  │
         ├── parser.js      regex line classifier ──────────────────────┤
         ├── state.js       single mutable state obj + CircularLogBuffer│
         ├── GpuManager     execFile(nvidia-smi) every 3–10 s ──────────┤
         ├── SseHub         50 ms-debounced fan-out ◄──────────────────-┘
         └── http.js        node:http, ~6 routes, cookie sessions
                                  │
                            browser: vanilla JS, EventSource, no build step
```

**Data flow is one-way:** miner stdout / nvidia-smi → mutate `state` → set `state.dirty` →
`SseHub.broadcast()` → JSON snapshot → DOM. There is no client→server state except three POST verbs.

### Deliberate constraints (do not "modernise" these away)
- **No `package.json`, no `node_modules`.** [verified: absent] Users drop a folder next to
  `VerthashMiner.exe` and double-click a `.bat`. Adding Express/dotenv/ws would break the core promise.
- **Windows + NVIDIA only.** `nvidia-smi.exe` and `taskkill.exe` are hardcoded (`gpu.js:77`, `miner.js:337`).
- **Trusted LAN, single operator.** Not internet-facing; the README says so explicitly.
- All 9 JS files pass `node --check`. [verified]

---

## 2. Confirmed defects (empirically reproduced)

### 🔴 A. SSE debounce starves clients under continuous miner output — **[verified]**
`SseHub.broadcast()` (`sse.js:16-21`) calls `clearTimeout` then re-arms a 50 ms timer on *every* update.
This is a **debounce**, not a throttle: while updates arrive faster than 50 ms, the timer is perpetually
reset and **nothing is ever sent**.

Reproduction (`state.dirty=true; hub.broadcast()` every 20 ms for 1 s):
```
broadcast() called ~50x over 1s of continuous updates
actual SSE frames written to client: 0     ← UI completely frozen
frames after traffic stops: 1
```
A chatty miner (`--protocol-dump` is force-appended in `config.js:79`, which *increases* line rate) can
hold the UI frozen indefinitely. **Fix:** trailing-edge throttle — if a timer is already armed, leave it
alone instead of clearing it. One-line change, high impact.

### 🔴 B. `gpuError` is captured but never reaches the UI — **[verified]**
`GpuManager` sets `state.gpuError` on nvidia-smi failure (`gpu.js:83`), but `formatStatsSnapshot()` never
includes it, and `script.js` never references it.
```
gpuError reachable by UI? false
snapshot keys: now, uptimeSeconds, acceptedRatio, startedAt, miner, mining, gpu, host
```
If `nvidia-smi` is missing from PATH — the single most likely setup failure, and one the README warns
about — the user sees "Waiting for GPU telemetry data..." **forever**, with no diagnostic.

### 🟠 C. OpenCL hashrates are parsed then silently dropped — **[verified]**
`parser.js` matches both `cu_` and `cl_` devices (`RX_DEV_HASH`), but `state.js:97` only ever reads
`gpuHashrates["cu_" + idx]`. With a `cl_0` device the per-GPU hashrate is `undefined`.
Either drop `cl` from the regex (honest: CUDA-only) or fall back to `cl_` on lookup.

### 🟠 D. Session expiry is a hard 30-minute logout with no renewal
`sessions.set(token, Date.now() + 1800*1000)` (`http.js:147`) and the TTL is never extended on activity.
An operator watching the rig gets kicked to the auth modal every 30 min mid-session. Slide the expiry
on each authenticated request (and re-issue the cookie) — the SSE stream is a perfect heartbeat for this.

### 🟠 E. Passphrase compared with `===` (`http.js:142`)
Non-constant-time. Mitigated by the 5-failures/30 s lockout, but `crypto.timingSafeEqual` on
pre-hashed buffers is free and removes the question entirely.

### 🟡 F. `handleConnection` rejects at 4 clients without reaping dead ones (`sse.js:57`)
The cap is a fixed `clients.size >= 4` [verified] with no sweep for half-open sockets. Combined with the
`4 per 10 s` `/events` rate limit, a laptop that sleeps/wakes a few times can lock itself out until a
socket-level timeout fires. Reap on cap-hit, or key the limit on live-connection count.

### 🟡 G. `Cache-Control: public, max-age=0` on static assets (`http.js:31`)
`public` on a passphrase-protected app permits shared-cache storage. Use `no-cache` (revalidate) or
`private`. Also: no `Content-Security-Policy` header anywhere [verified], while `script.js` injects
miner output into the DOM via `innerHTML`.

### 🟡 H. Log injection surface in `highlightSyntax` (`script.js`)
`escapeHtml()` runs **first** and the highlight regexes then insert `<span>` tags — that ordering is
correct and safe today. But it is fragile: any future `.replace()` added *before* the escape, or any new
field rendered with `setHtml`, silently becomes stored XSS from miner/pool-controlled text. Worth a
comment lock and a CSP as defence-in-depth.

---

## 3. Design observations worth knowing

**The `_pendingAction` 2-second delay** (`miner.js:requestAction`) debounces button-mashing and gives the
UI its `STARTING`/`STOPPING` state. Deliberate, but it means every control action has a floor of 2 s
latency — don't "optimise" it away without replacing the debounce.

**`enableParsing()` replays a 25-line history buffer** so a freshly-opened tab recovers recent state.
I checked the obvious risk — double-logging a line that was already pushed raw while the tab was closed —
and it does **not** duplicate [verified: 1 log entry, not 2], because the replay passes a no-op `pushLog`.
Subtle and correct; add a comment so nobody "fixes" it.

**The PCI-bus-ID join** (`miner.js:parseCudaDeviceList` → `state.js:formatStatsSnapshot`) is the sharpest
idea in the codebase: nvidia-smi's enumeration order and VerthashMiner's CUDA device indices don't
necessarily agree, so the code normalises `01:00.0` → `01:00:0` on both sides and joins on that, falling
back to positional index. This is exactly right for multi-GPU rigs. Note `pciMap` values are **strings**
(regex captures) while `g.index` is a **number** — the template-literal lookup papers over it, but it's a
latent trap.

**Incremental hashrate accounting** (`parser.js`: `total - oldHr + newHr`) avoids re-summing every device
per line, and `hashratesReady` waits until each device has reported twice before trusting the total.
Good instincts; the running total can drift on float accumulation over long uptimes — periodically
re-sum (e.g. every N updates) to re-anchor.

**Client render is diff-based** (`setText` compares before writing, GPU cards built once then patched by
id, logs appended by monotonic `id`). This is why the UI is cheap. Preserve it — a naive
`innerHTML = ...` rewrite would undo the project's whole point.

**Frontend fetches Google Fonts from a CDN** (`index.html`) on a tool explicitly documented as LAN/offline.
On an air-gapped rig the UI silently falls back to system fonts and pays two failed DNS lookups per load.

---

## 4. Priorities

| # | Item | Why now |
|---|---|---|
| 1 | Debounce → throttle in `SseHub` (A) | UI freezes exactly when the rig is busiest |
| 2 | Surface `gpuError` in snapshot + UI (B) | Turns the #1 setup failure from silent into obvious |
| 3 | Sliding session expiry (D) | Removes the most annoying daily papercut |
| 4 | `timingSafeEqual` + `Cache-Control: no-cache` + CSP (E, G, H) | Cheap, closes the LAN-exposure gaps |
| 5 | Resolve `cl_` hashrates or drop the regex branch (C) | Remove dead/misleading code path |
| 6 | Reap dead SSE clients before rejecting at cap (F) | Fixes sleep/wake lockout |

**Non-goals I'd argue against:** adding a framework or build step, adding npm dependencies, adding a
database for history, or making it cross-platform "for free". Each one taxes the zero-overhead,
zero-install promise that is the entire reason this project exists over a plain `.bat` file.

### Guardrails for any future change
1. Idle (no tab open) must remain **zero** spawns, **zero** parsing, **zero** timers doing real work.
2. No runtime dependencies; no build step. `node server.js` must stay the only command.
3. Client rendering stays diff-based.
4. Miner-controlled text is untrusted input — escape before it reaches `innerHTML`, always.
5. Fail fast and loudly on insecure config (the existing `SESSION_SECRET` / `PASSPHRASE` gates are a good
   pattern — extend it, don't weaken it).
