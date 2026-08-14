# VerthashMiner-Dashboard

Web monitor dashboard for the [VerthashMiner](https://github.com/CryptoGraphics/VerthashMiner).

A lightweight, zero-overhead Windows dashboard that acts as a wrapper around VerthashMiner to provide a beautiful web-based UI with live GPU telemetry.

## Compatibility & Requirements

- **CUDA Devices Only**: This dashboard relies on `nvidia-smi` for GPU telemetry and currently only supports NVIDIA/CUDA devices.
- **NVIDIA Drivers**: Ensure your NVIDIA graphics drivers are properly installed and `nvidia-smi` is available in your system PATH.
- **Windows Only**: Designed and tested specifically for Windows environments.
- **Node.js**: Requires Node.js installed and available as `node` in CMD. No `npm install` dependencies are required!
- **VerthashMiner**: This dashboard is a standalone module. You must download [VerthashMiner](https://github.com/CryptoGraphics/VerthashMiner) separately and place this dashboard folder in the same directory (or configure the path).

## What it does

- Starts VerthashMiner directly from Node.js.
- Reads the miner's stdout/stderr without changing its mining arguments.
- Polls `nvidia-smi` efficiently _only_ when the dashboard is open.
- Serves a premium glassmorphism-based web dashboard over HTTP.
- Uses Server-Sent Events (SSE) for live updates.
- 100% zero-overhead background operation (uses virtually 0% CPU/GPU when the browser tab is closed).

## Setup & Configuration

This dashboard is configured entirely through a `.env` file. We have provided a `.env.example` file that you should rename or copy to `.env`.

### 1. Create your `.env`

Copy `.env.example` to `.env` and fill it out:

**Example:**

```env
PORT=3000
HOST=127.0.0.1
GPU_POLL_MS=2000
DASHBOARD_TOKEN=a1b2c3d4e5f
MINER_EXE=VerthashMiner.exe
MINER_CWD=C:\Mining\VerthashMiner
MINER_ARGS=-u vtc1qwddxt3rmwx00ev9yg4qcwpxnguw5zm7mwej2xk -p c=VTC -o stratum+tcp://verthash.sea.mine.zpool.ca:6144 --verthash-data ..\Vertcoin\Vertcoin\verthash.dat --all-cu-devices
```

### 2. Configure Paths and Arguments

- **`MINER_CWD`**: This is the working directory where `VerthashMiner.exe` is located (e.g. `C:\Mining\VerthashMiner`). It must be set so the dashboard can find the executable and the `verthash.dat` file properly.
- **`MINER_ARGS`**: This variable determines how the dashboard launches the miner. You must supply your wallet address, pool, and path to the `verthash.dat` file exactly as you would in a normal `.bat` file.

_Make sure to include `--all-cu-devices` in `MINER_ARGS` since this dashboard tracks NVIDIA GPUs!_

### 3. Running the Dashboard

The recommended setup is to place this entire `VerthashMiner-Dashboard` folder directly inside your VerthashMiner directory.

Then in your main miner folder, create a batch file (name it whatever you like, e.g. `launch.bat` or `!START.bat`) with the following inside:

```bat
@echo off
cd /d "%~dp0"
node ".\VerthashMiner-Dashboard\server.js"
pause
```

Now you can just double click your batch file to spin up both the miner and dashboard simultaneously!

_(Alternatively, you can open CMD directly inside the dashboard folder and run `node server.js`)_

### 4. Access the Dashboard

- Local access (default): `http://127.0.0.1:3000`
- **Remote access**: To access the dashboard from another device on your LAN (e.g. `http://HOST:PORT`), you must edit your `.env` file and change `HOST=127.0.0.1` to `HOST=0.0.0.0` and restart the dashboard.

## Windows Firewall

If another device cannot connect, Windows Firewall may be blocking TCP 3000.
Create a narrowly scoped inbound rule for TCP 3000 on the Private profile. Do not expose this port directly to the public internet.

## API

- JSON status: `GET /api/status`
- Live stream: `GET /events`
- Health check: `GET /health`
