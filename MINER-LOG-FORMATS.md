# VerthashMiner Output Formats (verified against upstream source)

Reference for anyone touching `src/parser.js` or `src/miner.js`. Every format string below was read
directly from [CryptoGraphics/VerthashMiner](https://github.com/CryptoGraphics/VerthashMiner) — these are
not guesses. **If you change a regex, re-check it against this file.**

## Log line envelope

All log output goes through `applog()` (`src/vhCore/Util.cpp`):

```c
sprintf(f, "[%d-%02d-%02d %02d:%02d:%02d] %-5s %s\n", ...);
vfprintf(stderr, f, apTemp);   // <-- stderr, not stdout
```

Priorities (`ELogPriority`, `src/vhCore/Miner.h`): `ERROR`, `WARN`, `INFO`, `DEBUG` — padded to 5 chars
by `%-5s`.

```
[2026-08-17 12:34:56] INFO  cu_device(0): hashrate: 12.34 kH/s
[2026-08-17 12:34:56] ERROR Stratum connection timed out
 ^                  ^ ^
 idx 0 '['     idx 20 ']'   idx 22 = first letter of level (E/W/I/D)
```

The fast-path offsets in `classifyLine()` (`charCodeAt(20) === 93`, `charCodeAt(22)`) depend on this exact
layout. A timestamp format change upstream would silently break log-level detection.

> **Note:** everything is on **stderr**. `MinerManager` reads both pipes, so this works — but never
> "optimise" by dropping the stderr reader.

## Parsed lines

| What | Source | Format string |
|---|---|---|
| CUDA hashrate | `main.cpp:3177` | `cu_device(%d):%s%s%s%s hashrate: %.02f kH/s` |
| OpenCL hashrate | `main.cpp:2177` | `cl_device(%d):%s%s%s%s hashrate: %.02f kH/s` |
| Share result | `main.cpp:740` | `accepted: %lu/%lu (%.2f%%), total hashrate: %s` |
| Difficulty | `Util.cpp:1523` | `Stratum difficulty set to %g` |
| Stratum start | `main.cpp:3700` | `Starting Stratum on %s` |
| Reject reason | `main.cpp:747` | `reject reason: %s` (DEBUG only, needs `--debug`) |

The four `%s` in the device line are optional telemetry fields, each emitted only when available:

```c
" err:%u,"      // memTracker enabled  -> memory errors detected
" temp:%dC,"    // NVML temperature
" power:%dW,"   // NVML power
" fan:%d%%,"    // NVML fan speed
```

Producing e.g.:
```
[...] INFO  cu_device(0): err:0, temp:64C, power:120W, fan:55%, hashrate: 12.34 kH/s
```

`total hashrate: %s` is either `"%.2f kH/s"` or the literal `(pending...)` when the rate is still 0 —
the parser must not coerce `(pending...)` to `NaN`. Verified: it stays `null`.

### ⚠️ `err:N` is NOT an error

`" err:%u,"` is the **memory-error counter**, printed on a normal `INFO` hashrate line while the device is
still hashing fine. The old `RX_NZERR = /\b(?:errors?|err):\s*[1-9]\d*\b/i` matched it and painted healthy
telemetry red. Now scoped: `RX_NZERR` only matches standalone `errors: N`, and a separate `RX_DEV_MEMERR`
classifies `err:N,` as **warn** (not fatal — the device is still working).

### ⚠️ Stratum loss must not read as MINING

`Stratum connection failed/timed out/interrupted` (`main.cpp:3767,3777`, `Util.cpp:1225`) do not contain
any `RX_FATAL` keyword, so the dashboard previously kept showing **MINING** with a green dot while the
pool was gone. Now matched by `RX_STRATUM_DOWN` → status `DISCONNECTED` (amber, controls stay enabled,
since the process is alive and will reconnect). A subsequent hashrate line restores `MINING` and clears
the error.

## `--device-list` output

Plain `printf` to **stdout** (not `applog`), consumed by `parseCudaDeviceList()` to build the PCI→CUDA
index map:

```
OpenCL devices:
	Index: 0. Name: NVIDIA GeForce RTX 3070
	          Platform index: 0
	          Platform name: NVIDIA CUDA
	          pcieId: 01:00:0

CUDA devices:
	Index: 0. Name: NVIDIA GeForce RTX 3070. pcieId: 01:00:0
	Index: 1. Name: NVIDIA GeForce RTX 3060. pcieId: 02:00:0
```

- CUDA (`main.cpp:4744`): `"\tIndex: %u. Name: %s. pcieId: %s\n"` — single line, index and pcieId together
- OpenCL (`main.cpp:4711`): multi-line, pcieId on its own line
- pcieId (`main.cpp:4739`): `"%02x:%02x:0"` for CUDA, `"%02x:%02x:%01x"` for OpenCL
- Unavailable: the literal **`not avilable`** (sic — typo is upstream; the parser matches the typo)

### PCI join — verified working

`nvidia-smi --query-gpu=pci.bus_id` returns `00000000:01:00.0`; the miner reports `01:00:0`. Both are
normalised to `01:00:0` and joined. Confirmed end-to-end with two GPUs:

```
nvidia-smi parsed pciBusId: [ '01:00:0', '02:00:0' ]
miner --device-list  pciId: [ '01:00:0', '02:00:0' ]   MATCH? true

GPU0 NVIDIA GeForce RTX 3070  64C 120.5W  hr=12.79 kH/s
GPU1 NVIDIA GeForce RTX 3060  61C 110W    hr=10.72 kH/s
```

This is what makes per-GPU hashrate attribution correct when nvidia-smi enumeration order differs from
CUDA device order.

## Test emulator

`/tmp/fake-miner/VerthashMiner.js` reproduces all of the above byte-for-byte (stderr logging, `%-5s`
padding, `--device-list` on stdout, `(pending...)`, telemetry fields). Point `.env` at it to exercise the
full stack without a GPU:

```env
MINER_EXE=/tmp/fake-miner/VerthashMiner.exe
MINER_CWD=/tmp/fake-miner
MINER_ARGS=-u vtc1q... -o stratum+tcp://pool:6144 --all-cu-devices
```

Pair it with a stub `nvidia-smi.exe` on `PATH` emitting the 10-field CSV to test GPU telemetry too.
