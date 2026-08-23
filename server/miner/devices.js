"use strict";

const { LIMITS } = require("../utils/constants");

const RX_ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const RX_SECTION = /(cuda|opencl)\s.*?(devices:|device config)/i;
const RX_INLINE = /index:\s*(\d+).*?pcieid:\s*([0-9a-fA-F:.]+)/i;
const RX_INDEX = /deviceindex:\s*(\d+)/i;
const RX_PCI_LINE = /pcieid:\s*([0-9a-fA-F:.]+)/i;
const RX_UNAVAILABLE = /not\s*avilable/i;

const stripAnsi = (line) => String(line).replace(RX_ANSI, "");
const pad2 = (part) => (part.length === 1 ? `0${part}` : part);

function normalizePci(raw) {
  const text = String(raw).trim().toLowerCase();
  const parts = text.split(/[:.]/).filter(Boolean);
  if (parts.length >= 3) {
    const tail = parts.slice(-3);
    if (tail.every((part) => /^[0-9a-f]{1,8}$/.test(part))) return `${pad2(tail[0])}:${pad2(tail[1])}:${tail[2]}`;
  }
  if (parts.length === 2 && parts.every((part) => /^[0-9a-f]{1,8}$/.test(part))) return `${pad2(parts[0])}:${pad2(parts[1])}:0`;
  return text;
}

function parseCudaDeviceList(output, pciMap) {
  let inCuda = false, pendingIndex = null;
  for (const raw of String(output).split("\n")) {
    const line = stripAnsi(raw);
    const section = RX_SECTION.exec(line);
    if (section) { inCuda = section[1].toLowerCase() === "cuda"; pendingIndex = null; continue; }
    if (!inCuda) continue;
    const inline = RX_INLINE.exec(line);
    if (inline) {
      if (!RX_UNAVAILABLE.test(line)) pciMap[normalizePci(inline[2])] = inline[1];
      pendingIndex = null;
      continue;
    }
    const index = RX_INDEX.exec(line);
    if (index) { pendingIndex = index[1]; continue; }
    const pci = RX_PCI_LINE.exec(line);
    if (pci && pendingIndex != null && !RX_UNAVAILABLE.test(line)) {
      pciMap[normalizePci(pci[1])] = pendingIndex;
      pendingIndex = null;
    }
  }
  return pciMap;
}

function createStreamReader(onLine, onFlush, isEnabled, forward) {
  let buffer = "";
  return function handleChunk(chunk) {
    if (forward) forward(chunk);
    const enabled = isEnabled();
    if (!enabled) {
      buffer = "";
      return;
    }
    buffer += chunk;
    const cut = buffer.lastIndexOf("\n");
    if (cut === -1) {
      if (buffer.length > LIMITS.STREAM_BUFFER_BYTES) buffer = buffer.slice(-LIMITS.STREAM_BUFFER_BYTES);
      return;
    }
    const block = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    if (buffer.length > LIMITS.STREAM_BUFFER_BYTES) buffer = buffer.slice(-LIMITS.STREAM_BUFFER_BYTES);
    let start = 0;
    for (;;) {
      const nl = block.indexOf("\n", start);
      const end = nl === -1 ? block.length : nl;
      let line = block.slice(start, end);
      if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      if (line) onLine(line, enabled);
      if (nl === -1) break;
      start = nl + 1;
    }
    if (typeof onFlush === "function") onFlush();
  };
}

module.exports = { normalizePci, parseCudaDeviceList, createStreamReader, stripAnsi };
