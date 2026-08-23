"use strict";

const VALUE_FLAGS = Object.freeze({
  user: Object.freeze(["-u", "--user"]),
  pass: Object.freeze(["-p", "--pass", "--password"]),
  url: Object.freeze(["-o", "--url", "--server"]),
  algo: Object.freeze(["-a", "--algo"]),
  cert: Object.freeze(["--cert"]),
  proxy: Object.freeze(["-x", "--proxy"]),
  clDevices: Object.freeze(["-d", "--cl-devices"]),
  cuDevices: Object.freeze(["-D", "--cu-devices"]),
  retries: Object.freeze(["-r", "--retries"]),
  retryPause: Object.freeze(["-R", "--retry-pause"]),
  timeout: Object.freeze(["-T", "--timeout"]),
  scantime: Object.freeze(["-s", "--scantime"]),
  coinbaseAddr: Object.freeze(["--coinbase-addr"]),
  coinbaseSig: Object.freeze(["--coinbase-sig"]),
  config: Object.freeze(["-c", "--config"]),
  genConf: Object.freeze(["-g", "--gen-conf"]),
  genVerthashData: Object.freeze(["--gen-verthash-data"]),
  verthashData: Object.freeze(["-f", "--verthash-data"]),
});

const BOOL_FLAGS = Object.freeze({
  protocolDump: Object.freeze(["-P", "--protocol-dump"]),
  allClDevices: Object.freeze(["--all-cl-devices"]),
  allCuDevices: Object.freeze(["--all-cu-devices"]),
  noLongpoll: Object.freeze(["--no-longpoll"]),
  noRedirect: Object.freeze(["--no-redirect"]),
  noRestrictCuda: Object.freeze(["--no-restrict-cuda"]),
  verbose: Object.freeze(["--verbose"]),
  benchmark: Object.freeze(["--benchmark"]),
  noVerthashVerify: Object.freeze(["--no-verthash-data_verification"]),
  logFile: Object.freeze(["--log-file"]),
  deviceList: Object.freeze(["-l", "--device-list"]),
  version: Object.freeze(["-v", "--version"]),
  help: Object.freeze(["-h", "--help"]),
});

function flagIndex() {
  const map = Object.create(null);
  for (const [key, names] of Object.entries(VALUE_FLAGS)) {
    for (const name of names) map[name] = { key, kind: "value" };
  }
  for (const [key, names] of Object.entries(BOOL_FLAGS)) {
    for (const name of names) map[name] = { key, kind: "bool" };
  }
  return map;
}

const FLAG_INDEX = flagIndex();

function parseMinerArgs(args) {
  const out = Object.create(null);
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    let name = token;
    let inline = null;
    const eq = token.indexOf("=");
    if (eq > 1 && token.startsWith("-")) {
      name = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }
    const spec = FLAG_INDEX[name];
    if (!spec) continue;
    if (spec.kind === "bool") {
      out[spec.key] = true;
      continue;
    }
    if (inline != null) {
      out[spec.key] = inline;
      continue;
    }
    if (i + 1 < args.length) {
      out[spec.key] = args[++i];
    }
  }
  return out;
}

module.exports = { parseMinerArgs };

