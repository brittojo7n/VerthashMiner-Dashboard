# VerthashMiner Dashboard

Lightweight web dashboard for VerthashMiner. Launches the miner, streams live logs, and shows GPU telemetry.

## Prerequisites

- Windows with NVIDIA GPUs and `nvidia-smi` on PATH
- Node.js 18+ available as `node`
- VerthashMiner downloaded separately
- `verthash.dat` placed in the miner folder

## Setup

1. Place this dashboard folder next to your miner folder.
2. Create a `.env` file in the dashboard root:

```env
PORT=4067
HOST=0.0.0.0
PASSPHRASE=your-secret-passphrase
SESSION_SECRET=your_random_64_character_hex_string
MINER_CWD=miner
MINER_ARGS=-u vtc1qwddxt3rmwx00ev9yg4qcwpxnguw5zm7mwej2xk -p c=VTC -o stratum+tcp://pool.example.com:6144 --verthash-data ..\..\Vertcoin\Vertcoin\verthash.dat --all-cu-devices
```

| Variable | Purpose |
|----------|---------|
| `PORT` | Dashboard port. Default `4067`. |
| `HOST` | Bind address. Use `0.0.0.0` for LAN access, `127.0.0.1` for local only. Non-local binds **require** `PASSPHRASE`. |
| `PASSPHRASE` | Web UI password. Required when `HOST` is non-local. |
| `SESSION_SECRET` | Random string (≥32 chars) used to sign session cookies. Required. |
| `MINER_CWD` | Path to the miner folder (relative or absolute). |
| `MINER_ARGS` | Miner command-line arguments. `--protocol-dump` is appended automatically. Include `--all-cu-devices` (or `--cu-devices 1,3`) so telemetry maps to the correct GPUs. |
| `GPU_POLL_MS` | `nvidia-smi` poll interval in ms. Default `5000`. Clamped to `3000–10000`. |
| `FORWARD_CONSOLE` | `true` mirrors miner output to the launcher terminal. Default `false`. |
| `ENV_FILE` | Optional path to an alternative env file. Real environment variables take precedence. |

## Start

```bat
node server.js
```

Open `http://127.0.0.1:4067` (or your LAN IP) and enter the passphrase.

To stop mining from the dashboard, use the **STOP** button. To start again, use **START**.
