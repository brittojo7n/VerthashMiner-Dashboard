# VerthashMiner Dashboard

> Zero-overhead real-time web monitor & GPU telemetry for VerthashMiner (Vertcoin / VTC)

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://britto.is-a.dev)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)](https://britto.is-a.dev)
[![GPU](https://img.shields.io/badge/GPU-NVIDIA%20CUDA-76B900?logo=nvidia&logoColor=white)](https://britto.is-a.dev)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](https://britto.is-a.dev)

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

### 1. Clone the Repository

Clone this repository directly into your VerthashMiner directory (or any preferred location):

```bash
git clone https://github.com/brittojo7n/VerthashMiner-Dashboard.git
cd VerthashMiner-Dashboard
```

### 2. Create your `.env`

Copy `.env.example` to `.env` and configure your settings:

**Example:**

```env
PORT=3000
HOST=127.0.0.1
GPU_POLL_MS=2000
MAX_LOGS=50
PASSPHRASE=abc123
MINER_EXE=VerthashMiner.exe
MINER_CWD=C:\Mining\VerthashMiner
MINER_ARGS=-u vtc1qwddxt3rmwx00ev9yg4qcwpxnguw5zm7mwej2xk -p c=VTC -o stratum+tcp://verthash.sea.mine.zpool.ca:6144 --verthash-data ..\Vertcoin\Vertcoin\verthash.dat --all-cu-devices
```

### 3. Configure Paths and Arguments

- **`MINER_CWD`**: This is the working directory where `VerthashMiner.exe` is located (e.g. `C:\Mining\VerthashMiner`). It must be set so the dashboard can find the executable and the `verthash.dat` file properly.
- **`MINER_ARGS`**: This variable determines how the dashboard launches the miner. You must supply your wallet address, pool, and path to the `verthash.dat` file exactly as you would in a normal `.bat` file.
- **`MAX_LOGS`**: Sets the maximum number of console logs to hold in memory and display on the dashboard (default is 50, minimum is 15, maximum is 500).

_Make sure to include `--all-cu-devices` in `MINER_ARGS` since this dashboard tracks NVIDIA GPUs!_

### 4. Running the Dashboard

Put the entire folder (`VerthashMiner-Dashboard`) right where the folder for `VerthashMiner` is situated, and then create the following batch file outside both folders (name it anything you like, such as `launch.bat` or `start.bat`):

```bat
@echo off
setlocal

net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

node ".\VerthashMiner-Dashboard\server.js"
pause
```

Now you can just double click your batch file to spin up both the miner and dashboard simultaneously!

_(Alternatively, you can open CMD directly inside the dashboard folder and run `node server.js`)_

### 5. Access the Dashboard

- Local access (default): `http://127.0.0.1:3000`
- **Remote access**: To access the dashboard from another device on your LAN (e.g. `http://HOST:PORT`), you must edit your `.env` file and change `HOST=127.0.0.1` to `HOST=0.0.0.0` and restart the dashboard.

## Windows Firewall

If another device cannot connect, Windows Firewall may be blocking TCP 3000.
Create a narrowly scoped inbound rule for TCP 3000 on the Private profile. Do not expose this port directly to the public internet.

## API

- JSON status: `GET /api/status`
- Live stream: `GET /events`
- Health check: `GET /health`
