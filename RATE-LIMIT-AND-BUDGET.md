# Rate Limits & Resource Budget — Measured Report

> **Status: resolved.** This document records the original investigation at commit
> `1f3bb87`. Every defect listed here has since been fixed and covered by tests
> (`./test/all.sh`). File paths referring to `public/script.js` predate the split
> into `public/js/*`. Kept for the rationale behind each change.

_All numbers measured on this checkout (`1f3bb87`), Node v22.22.3, Linux sandbox. Nothing here is estimated._

---

## Part 1 — The 20 MB / 0.01% CPU target

### CPU: ✅ target met, with room to spare

| Scenario | Measured CPU |
|---|---|
| Idle, no browser tab open (15 s window) | **0.00000%** — literally 0 scheduler jiffies |
| Active SSE client attached (20 s window) | **0.05%** (1 jiffy total) |

Idle is *exactly* zero, which validates the subscriber-gated design: no tab → no timers doing work →
the process is never scheduled. The 0.05% active figure is one single jiffy — measurement granularity,
not real load. On a mining rig, this is noise.

**Caveat:** this box has no NVIDIA GPU, so `nvidia-smi` never actually ran. On a real rig each poll is a
process spawn every 3–10 s. That is the dominant CPU cost and it is *not* represented above. Expect a
brief spike per poll (spawn + parse), amortised to well under 0.1% at a 5 s interval — but it will not be
0.01% *while a tab is open*. It will be 0.01%-ish averaged, and ~0% with all tabs closed.

### Memory: ❌ 20 MB is not physically achievable on Node

This is the important finding, and it is not a code-quality problem.

| Configuration | RSS |
|---|---|
| **Empty script** (`setInterval(()=>{},...)`), nothing else | **39.5 MB** |
| Empty script + `--max-old-space-size=32 --max-semi-space-size=1` | 39.8 MB (no help) |
| Bare `node:http` server, one route | 45.1 MB |
| **This dashboard, idle, no client** | **47.9 MB** |
| This dashboard after 300 requests | 57.8 MB (peak `VmHWM` 57.7 MB) |
| This dashboard with heap flags, after 300 requests | 57.4 MB (**flags don't help**) |

**The V8/Node runtime floor is ~39.5 MB before a single line of application code executes.** The 20 MB
target is below the floor of the platform. No amount of native-JS discipline can reach it — you'd need a
different runtime entirely.

#### What the app itself actually costs

Splitting the numbers isolates the real application footprint:

```
This dashboard idle   47.9 MB
Bare http server      45.1 MB
────────────────────────────────
Application code       ≈ 2.8 MB   ← everything you wrote
```

**The dashboard's own code is ~2.8 MB.** It is already extremely lean. The other 45 MB is Node itself.

#### The RSS growth (47.9 → 57.8 MB) is not a leak

I checked this specifically, because it looks alarming. `smaps_rollup` after the load test:

```
Rss:         57924 kB
Pss_File:    43814 kB   ← 76% is file-backed: the node binary + V8 snapshot, mapped in
Pss_Anon:    12320 kB   ← actual heap/anon memory
Pss_Dirty:   12360 kB
```

Three things confirm it's benign:
1. **76% of RSS is `Pss_File`** — read-only pages of the `node` executable being paged in on demand as
   more of the runtime gets touched. Shared, evictable, not "used" memory in any meaningful sense.
2. **RSS plateaus and holds flat** at 57960 kB across four consecutive 5 s idle samples — a leak would
   keep climbing.
3. Real anonymous memory is only **~12 MB**, and `heapUsed` was 3.62 MB.

So: growth is V8 warming up and lazily faulting in its own binary, not the app retaining objects. The
`CircularLogBuffer` is fixed-size by construction, and the session/rate-limit `Map`s are explicitly
bounded (128 buckets, 100 login entries, 50-session eviction) — the code is already disciplined here.

### Recommendation on the budget

**Restate the target as: "< 3 MB of application memory above the Node runtime floor, and ~0% CPU when
idle."** That is a real, defensible, *already-met* engineering claim. "20 MB total" is unachievable and
publishing it in the README would be a promise the project can't keep.

If a hard sub-20 MB total is a genuine requirement, the only paths are runtime changes, not code changes
— and each breaks the "just install Node and double-click a .bat" promise:
- **Bun** (~15–20 MB floor) — but adds an install step, and `--max-old-space` semantics differ
- **QuickJS / a compiled binary** — kills the zero-install story completely
- Not worth it. The current design is the right trade.

---

## Part 2 — Rate limits under aggressive refresh

### The configured limits (`src/http.js`)

```js
const allowMiner  = createRateLimiter(3,  5000);   // POST /api/miner/*  — 3 per 5 s
const allowStatus = createRateLimiter(10, 5000);   // GET  /api/status   — 10 per 5 s
const allowEvents = createRateLimiter(4, 10000);   // GET  /events       — 4 per 10 s
```

Static assets (`/`, `/style.css`, `/script.js`) are **not** rate-limited at all.

### Measured behaviour: 20 rapid refreshes

One real browser refresh = `GET /` + `/style.css` + `/script.js` + `/api/status` + `/events`.
I simulated the two limited endpoints per refresh:

```
refresh 1-4 : index=200  /api/status=200  /events=200
refresh 5   : index=200  /api/status=200  /events=429   ← SSE dies first
refresh 11  : index=200  /api/status=429  /events=429   ← status dies too
refresh 20  : index=200  /api/status=429  /events=429
```

**The 5th refresh within 10 seconds locks the user out of live updates.** Recovery is clean and fast
(both endpoints returned 200 at the next 2 s sample once the window rolled), so the *limiter itself* is
working correctly and the windows are sanely sized.

### 🔴 The real bug: the client dead-ends on 429, permanently

The limiter is fine. **The client's handling of it is broken.** `init()` in `public/script.js`:

```js
const res = await fetch("/api/status");
if (res.status === 401)      showAuthModal();
else if (res.ok)             connectSSE();
// 429 → falls through BOTH branches → returns → nothing ever happens again
```

And critically — the `catch { setTimeout(init, 5000) }` retry **never fires on a 429**, because
`fetch()` only rejects on *network* failure. A 429 is a perfectly successful HTTP response, so it
resolves, misses every branch, and `init()` just returns.

Verified branch-by-branch:
```
/api/status -> 200:  connectSSE()
/api/status -> 401:  showAuthModal()
/api/status -> 429:  *** NOTHING — no retry, no UI update, permanent dead end ***
/api/status -> 500:  *** NOTHING — no retry, no UI update, permanent dead end ***
```

**User-visible result:** hit F5 five times quickly (exactly what an impatient user does when a dashboard
looks stuck) and you get a permanently blank dashboard — stuck on "Initializing connection..." with no
error, no spinner, no retry. It stays dead **until you manually refresh again** *after* the window
clears. The self-inflicted-lockout is the worst possible failure mode: the cure (refresh) is the disease.

The same hole applies to any 5xx.

### 🟠 Secondary issues

**Rate limiter is keyed on `req.socket.remoteAddress`.** All LAN users behind the same NAT/host share one
bucket. On a single-operator rig this is fine, but two people on two devices *do* interfere. Worth a
comment noting the assumption.

**`/events` limit (4/10 s) is tighter than the SSE client cap (4 concurrent)** and, as noted in
ANALYSIS.md §F, dead connections aren't reaped before the cap is enforced. Sleep/wake cycles burn
reconnect budget. These two limits should be reasoned about together.

**Static assets are unlimited** — so a refresh storm still costs full HTTP handling for three files each
time. They're served from an in-memory cache so it's cheap, but it means the "refresh storm" load isn't
actually being shed, just the useful endpoints.

### Recommended fixes (all native JS, no packages)

1. **Handle 429 explicitly in `init()` and `onerror`** — read the window, show
   "Reconnecting in Ns…", and `setTimeout(init, delay)`. This is the one that matters.
2. **Add a catch-all `else`** so *any* unexpected status schedules a retry instead of dead-ending.
3. **Send `Retry-After` on every 429** so the client can back off intelligently instead of guessing.
4. **Exponential backoff with jitter** on reconnect, capped at ~30 s — prevents a reload storm from
   re-triggering the limit the moment it clears.
5. Raise `/events` to ~6/10 s *or* reap dead clients first — 4 is tight for a tab that sleeps/wakes.

Fixes 1–3 are perhaps 20 lines total and turn a permanent blank-screen lockout into a self-healing
"reconnecting…" state.

---

## Summary

| Question | Answer |
|---|---|
| Idle CPU | **0.00000%** ✅ — subscriber gating genuinely works |
| Active CPU | 0.05% (1 jiffy; noise) ✅ — excludes real `nvidia-smi` spawns |
| Total RSS | 47.9 MB idle / 57.8 MB peak ❌ vs 20 MB target |
| **App's own memory** | **~2.8 MB** ✅ — the code is already excellent |
| Node runtime floor | **39.5 MB** — the 20 MB target is below the platform's floor |
| Memory leak? | **No** — 76% file-backed, plateaus flat, heapUsed 3.6 MB |
| Rate limiters correct? | **Yes** — trigger and recover as designed |
| Client handling of 429? | **🔴 Broken** — permanent dead-end blank dashboard |
