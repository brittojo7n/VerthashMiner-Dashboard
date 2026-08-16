"use strict";

const { LIMITS } = require("./constants");

const RX_ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const RX_PCI = /([0-9a-fA-F]{2}):([0-9a-fA-F]{2})\.?([0-9a-fA-F]?)/;
const RX_SECTION = /(cuda|opencl)\s.*(devices:|device config)/i;
const RX_INLINE = /index:\s*(\d+).*?pcieid:\s*([0-9a-fA-F:.]+)/i;
const RX_INDEX = /deviceindex:\s*(\d+)/i;
const RX_PCI_LINE = /pcieid:\s*([0-9a-fA-F:.]+)/i;
// The miner really does print "not avilable" (typo is upstream).
const RX_UNAVAILABLE = /not\s*avilable/i;

/** Strip ANSI colour sequences the miner emits when attached to a console. */
const stripAnsi = line => String(line).replace(RX_ANSI, "");

/**
 * Normalise a PCI id to `bb:dd:f`.
 *
 * nvidia-smi reports `00000000:01:00.0` while VerthashMiner prints `01:00:0`;
 * reducing both to one form is what lets per-GPU hashrates be matched to
 * telemetry when the two enumeration orders disagree.
 */
function normalizePci(raw) {
  const m = RX_PCI.exec(String(raw));
  return m
    ? `${m[1].toLowerCase()}:${m[2].toLowerCase()}:${(m[3] || "0").toLowerCase()}`
    : String(raw).toLowerCase();
}

/**
 * Parse `--device-list` output into a `{ pciId: cudaIndex }` map.
 *
 * Only the CUDA section is consumed; the OpenCL block lists the same cards and
 * would otherwise overwrite the indices the miner actually uses. Both the
 * single-line CUDA form and the multi-line OpenCL form are handled.
 *
 * @param {string} output
 * @param {Record<string,string>} pciMap Mutated in place.
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
      pciMap[normalizePci(inline[2])] = inline[1];
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
}

/**
 * Split a child process stream into whole lines.
 *
 * Chunks arrive at arbitrary boundaries, so a partial trailing line is carried
 * over. The buffer is capped to bound memory if the child ever emits a very
 * long line with no newline.
 *
 * @param {(line: string, enabled: boolean) => void} onLine
 * @param {() => void} onFlush   Called once per chunk that produced lines.
 * @param {() => boolean} isEnabled
 * @param {((chunk: string) => void)|null} forward Optional console mirror.
 */
function createStreamReader(onLine, onFlush, isEnabled, forward) {
  let buffer = "";

  return function handleChunk(chunk) {
    if (forward) forward(chunk);
    buffer += chunk;

    if (buffer.length > LIMITS.STREAM_BUFFER_BYTES) {
      const lastNewline = buffer.lastIndexOf("\n");
      buffer = lastNewline === -1 ? "" : buffer.slice(lastNewline + 1);
    }

    const cut = buffer.lastIndexOf("\n");
    if (cut === -1) return;

    const enabled = isEnabled();
    for (const line of buffer.slice(0, cut).split(/\r?\n/)) {
      if (line) onLine(line, enabled);
    }
    buffer = buffer.slice(cut + 1);
    if (enabled) onFlush?.();
  };
}

module.exports = { normalizePci, parseCudaDeviceList, createStreamReader, stripAnsi };
