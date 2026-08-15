const RX_NORM    = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const RX_HASH    = /(?:total )?hashrate:\s*([\d.]+)\s*kH\/s/i;
const RX_DIFF    = /difficulty(?:\s*(?:set|is))?\s*(?:to|:)?\s*([\d.]+)/i;
const RX_ACC     = /accepted:\s*(\d+)\s*\/\s*(\d+)/i;
const RX_ERR     = /\b(?:\[error\]|\[fatal\]|error:|fatal:|cuda\s+error|out\s+of\s+memory|failed\s+to|connection\s+refused|connection\s+failed|enoent|exception)\b/i;
const RX_NZERR   = /\b(?:errors?|err):\s*[1-9]\d*\b/i;
const RX_WARN    = /\b(?:\[warn(?:ing)?\]|warning:|warn:|\bwarnings?:\s*[1-9]\d*)\b/i;
const RX_SUCCESS = /\b(?:accepted:\s*\d+\s*\/\s*\d+|share\s+accepted|loaded\s+succes|verified\s+succes|successfully\s+configured)\b/i;
const RX_FATAL   = /\b(?:cuda\s+error|failed\s+to|fatal|exception|enoent)\b/i;
const RX_WARN0   = /\bwarnings?:\s*0\b/i;
const RX_ERR0    = /\b(?:errors?|err):\s*0\b/i;

function classifyLine(line, lc) {
  const isErr = RX_NZERR.test(line) || (RX_ERR.test(line) && (!RX_ERR0.test(line) || RX_FATAL.test(line)));
  const isWarn = !isErr && RX_WARN.test(line) && !RX_WARN0.test(line);

  let type = "info";
  if (isErr)                    type = "error";
  else if (isWarn)              type = "warn";
  else if (RX_SUCCESS.test(line)) type = "success";
  else if (lc.includes("stratum") || lc.includes("difficulty") || lc.includes("hashrate:") || lc.includes("device")) type = "accent";

  return { isErr, type };
}

function parseMinerLine(raw, state, pushLog) {
  const line = String(raw).replace(RX_NORM, "").trim();
  if (!line) return;

  const lc = line.toLowerCase();
  const { isErr, type } = classifyLine(line, lc);

  if (isErr) {
    state.miner.lastError = line;
    state.mining.status = "ERROR";
  }

  if (typeof pushLog === "function") {
    pushLog(line, type);
  } else if (state.miner.logs) {
    state.miner.logs.push(line, type);
    state.miner.lastLine = line;
  }

  const hrMatch = line.match(RX_HASH);
  if (hrMatch) {
    const hr = Number(hrMatch[1]);
    state.mining.hashrateKHs = hr;
    if (hr > 0) {
      state.mining.status = "MINING";
      if (!isErr) state.miner.lastError = "";
    }
  }

  const diffMatch = line.match(RX_DIFF);
  if (diffMatch) state.mining.difficulty = Number(diffMatch[1]);

  const acc = line.match(RX_ACC);
  if (acc) {
    state.mining.accepted     = Number(acc[1]);
    state.mining.submitted    = Number(acc[2]);
    state.mining.rejected     = state.mining.submitted - state.mining.accepted;
    if (state.mining.rejected < 0) state.mining.rejected = 0;
    state.mining.status       = "MINING";
    state.mining.lastAcceptedAt = Date.now();
    state.miner.lastError     = "";
  }

  if (!isErr && state.mining.status !== "MINING") {
    if (lc.includes("stratum") && lc.includes("connect")) {
      state.mining.status = "CONNECTED";
    } else if (lc.includes("waiting") || lc.includes("paused") || lc.includes("no work")) {
      state.mining.status = "WAITING";
    }
  }

  process.stdout.write(raw.endsWith("\n") ? raw : raw + "\n");
}

module.exports = { parseMinerLine };
