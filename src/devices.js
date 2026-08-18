"use strict";

const { LIMITS } = require("./constants");

const RX_ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const RX_SECTION = /(cuda|opencl)\s.*(devices:|device config)/i;
const RX_INLINE = /index:\s*(\d+).*?pcieid:\s*([0-9a-fA-F:.]+)/i;
const RX_INDEX = /deviceindex:\s*(\d+)/i;
const RX_PCI_LINE = /pcieid:\s*([0-9a-fA-F:.]+)/i;

/** Upstream prints "not avilable" (sic) when a device exposes no PCI id. */
const RX_UNAVAILABLE = /not\s*avilable/i;

const stripAnsi = line => String(line).replace(RX_ANSI, "");

const pad2 = part => (part.length === 1 ? `0${part}` : part);

/**
 * Canonical PCI join key.
 *
 * nvidia-smi reports `00000000:01:00.0` (with a domain prefix) while
 * VerthashMiner reports `01:00:0`. Both must collapse to the same key or GPU
 * telemetry gets attached to the wrong device. Parsing from the right-hand
 * side is what makes the domain prefix harmless.
 *
 * @param {string} raw
 * @returns {string} `bb:dd:f`, or the lower-cased input when unparseable
 */
function normalizePci(raw) {
  const text = String(raw).trim().toLowerCase();
  const parts = text.split(/[:.]/).filter(Boolean);

  if (parts.length >= 3) {
    const tail = parts.slice(-3);
    if (tail.every(part => /^[0-9a-f]{1,8}$/.test(part))) {
      return `${pad2(tail[0])}:${pad2(tail[1])}:${tail[2]}`;
    }
  }
  if (parts.length === 2 && parts.every(part => /^[0-9a-f]{1,8}$/.test(part))) {
    return `${pad2(parts[0])}:${pad2(parts[1])}:0`;
  }
  return text;
}

/**
 * Extracts the CUDA section of `--device-list` (or a generated config file)
 * into `pciMap`: normalised PCI id -> CUDA device index.
 *
 * @param {string} output raw probe output
 * @param {Record<string,string>} pciMap mutated in place
 */
function parseCudaDeviceList(output, pciMap) {
  let inCuda = false;
  let pendingIndex = null;

  for (const raw of String(output).split("\n")) {
    const line = stripAnsi(raw);
    const section = RX_SECTION.exec(line);
    if (section) {
      inCuda = section[1].toLowerCase() === "cuda";
      pendingIndex = null;
      continue;
    }
    if (!inCuda) continue;

    const inline = RX_INLINE.exec(line);
    if (inline) {
      if (!RX_UNAVAILABLE.test(line)) pciMap[normalizePci(inline[2])] = inline[1];
      pendingIndex = null;
      continue;
    }

    const index = RX_INDEX.exec(line);
    if (index) {
      pendingIndex = index[1];
      continue;
    }

    const pci = RX_PCI_LINE.exec(line);
    if (pci && pendingIndex != null && !RX_UNAVAILABLE.test(line)) {
      pciMap[normalizePci(pci[1])] = pendingIndex;
      pendingIndex = null;
    }
  }
  return pciMap;
}

/**
 * Chunk -> line adapter for a child process stream.
 *
 * Guarantees:
 *  - complete lines are never dropped, even when a chunk boundary splits them;
 *  - an unterminated line can never grow the buffer without bound;
 *  - CRLF and LF are both handled;
 *  - `onFlush` fires at most once per chunk, and only while a client is attached.
 *
 * @param {(line: string, enabled: boolean) => void} onLine
 * @param {() => void} [onFlush]
 * @param {() => boolean} isEnabled
 * @param {(chunk: string) => void} [forward] optional local console mirror
 */
function createStreamReader(onLine, onFlush, isEnabled, forward) {
  let buffer = "";

  return function handleChunk(chunk) {
    if (forward) forward(chunk);
    buffer += chunk;

    const cut = buffer.lastIndexOf("\n");
    if (cut === -1) {
      // No complete line yet. Cap the partial line so a miner that never emits
      // a newline cannot grow our heap.
      if (buffer.length > LIMITS.STREAM_BUFFER_BYTES) {
        buffer = buffer.slice(buffer.length - LIMITS.STREAM_BUFFER_BYTES);
      }
      return;
    }

    const block = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    if (buffer.length > LIMITS.STREAM_BUFFER_BYTES) {
      buffer = buffer.slice(buffer.length - LIMITS.STREAM_BUFFER_BYTES);
    }

    const enabled = isEnabled();
    let start = 0;
    for (;;) {
      const nl = block.indexOf("\n", start);
      const end = nl === -1 ? block.length : nl;
      let line = block.slice(start, end);
      if (line.charCodeAt(line.length - 1) === 13 /* \r */) line = line.slice(0, -1);
      if (line) onLine(line, enabled);
      if (nl === -1) break;
      start = nl + 1;
    }

    if (enabled && typeof onFlush === "function") onFlush();
  };
}

module.exports = { normalizePci, parseCudaDeviceList, createStreamReader, stripAnsi };
