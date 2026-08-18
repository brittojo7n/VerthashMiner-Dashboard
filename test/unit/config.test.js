"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRateLimiter } = require("../../src/ratelimit");
const { buildConfig, validateConfig, advisories, parseEnvFile, splitArgs } = require("../../src/config");
const { delay } = require("../helpers/harness");

/* -------------------------------------------------------------- rate limit */

test("requests inside the window are allowed, then throttled", () => {
  const limit = createRateLimiter(3, 1000);
  assert.equal(limit("a"), 0);
  assert.equal(limit("a"), 0);
  assert.equal(limit("a"), 0);
  assert.ok(limit("a") > 0);
  assert.equal(limit("b"), 0, "buckets are per key");
});

test("the penalty window extends the cool-off exactly once", () => {
  const limit = createRateLimiter(1, 50, 500);
  assert.equal(limit("x"), 0);
  const first = limit("x");
  const second = limit("x");
  assert.ok(first > 100, `penalty applied: ${first}`);
  assert.ok(second <= first, "penalty is not re-applied on every call");
});

test("the window resets once it elapses", async () => {
  const limit = createRateLimiter(1, 60);
  assert.equal(limit("k"), 0);
  assert.ok(limit("k") > 0);
  await delay(80);
  assert.equal(limit("k"), 0);
});

test("bucket storage stays bounded under key flooding", () => {
  const limit = createRateLimiter(5, 60_000);
  for (let i = 0; i < 10_000; i++) limit(`ip-${i}`);
  assert.equal(limit("ip-0"), 0, "still functional after eviction");
});

/* ------------------------------------------------------------------ config */

test(".env parsing handles quotes, comments and blank lines", () => {
  const parsed = parseEnvFile(
    [
      "# comment",
      "",
      "PORT=4067",
      'PASSPHRASE="secret with spaces"',
      "SESSION_SECRET='single'",
      "HOST=0.0.0.0 # inline comment",
      "EMPTY=",
      "no_equals_here",
      "SPACED  =  value  "
    ].join("\n")
  );

  assert.equal(parsed.PORT, "4067");
  assert.equal(parsed.PASSPHRASE, "secret with spaces");
  assert.equal(parsed.SESSION_SECRET, "single");
  assert.equal(parsed.HOST, "0.0.0.0");
  assert.equal(parsed.EMPTY, "");
  assert.equal(parsed.SPACED, "value");
  assert.equal("no_equals_here" in parsed, false);
});

test("argument splitting keeps quoted paths intact", () => {
  const args = splitArgs('-u wallet --verthash-data "C:\\Program Files\\vh\\verthash.dat" --all-cu-devices');
  assert.deepEqual(args, [
    "-u",
    "wallet",
    "--verthash-data",
    "C:\\Program Files\\vh\\verthash.dat",
    "--all-cu-devices"
  ]);
});

test("the documented deployment config is parsed correctly", () => {
  const config = buildConfig(
    {
      PORT: "4067",
      HOST: "0.0.0.0",
      FORWARD_CONSOLE: "true",
      PASSPHRASE: "7654321abcdefg",
      SESSION_SECRET: "example_give_some_string_of_64_char_in_length",
      MINER_CWD: "miner",
      MINER_ARGS:
        "-u vtc1qwddxt3rmwx00ev9yg4qcwpxnguw5zm7mwej2xk -p c=VTC " +
        "-o stratum+tcp://verthash.sea.mine.zpool.ca:6144 " +
        "--verthash-data ..\\..\\Vertcoin\\Vertcoin\\verthash.dat --all-cu-devices"
    },
    { platform: "win32" }
  );

  assert.equal(config.PORT, 4067);
  assert.equal(config.HOST, "0.0.0.0");
  assert.equal(config.FORWARD_CONSOLE, true);
  assert.equal(config.MINER_EXE, "VerthashMiner.exe");
  assert.equal(config.WALLET, "vtc1qwddxt3rmwx00ev9yg4qcwpxnguw5zm7mwej2xk");
  assert.equal(config.GPU_POLL_MS, 5000, "default applies when unset");
  assert.equal(config.MAX_LOGS, 50);
  assert.ok(config.MINER_ARGS.includes("--protocol-dump"), "reject reasons need the dump");
  assert.equal(config.DEVICE_SELECTION.cu, null, "--all-cu-devices means identity mapping");
  assert.deepEqual(validateConfig(config), [], "config must be accepted");
});

test("the wallet is read from every supported argument form", () => {
  const forms = [
    ["-u", "-u vtc1abc"],
    ["--user", "--user vtc1abc"],
    ["-u=", "-u=vtc1abc"],
    ["--user=", "--user=vtc1abc"]
  ];
  for (const [label, args] of forms) {
    const config = buildConfig({ MINER_ARGS: args, SESSION_SECRET: "s" });
    assert.equal(config.WALLET, "vtc1abc", label);
  }
  assert.equal(buildConfig({ MINER_ARGS: "-u vtc1abc.rig1" }).WALLET, "vtc1abc", "worker suffix stripped");
  assert.equal(buildConfig({ MINER_ARGS: "" }).WALLET, "");
});

test("device subsets produce a worker -> device mapping", () => {
  const subset = buildConfig({ MINER_ARGS: "-u w --cu-devices 1,3 --cl-devices 0" });
  assert.deepEqual(subset.DEVICE_SELECTION.cu, [1, 3]);
  assert.deepEqual(subset.DEVICE_SELECTION.cl, [0]);

  const all = buildConfig({ MINER_ARGS: "-u w --all-cu-devices" });
  assert.equal(all.DEVICE_SELECTION.cu, null);
});

test("out-of-range values are clamped, not trusted", () => {
  const low = buildConfig({ GPU_POLL_MS: "100", MAX_LOGS: "1", PORT: "-5" });
  assert.equal(low.GPU_POLL_MS, 3000);
  assert.equal(low.MAX_LOGS, 15);
  assert.equal(low.PORT, 0);
  assert.equal(buildConfig({ PORT: "0" }).PORT, 0, "0 means: let the OS pick a port");

  const high = buildConfig({ GPU_POLL_MS: "999999", MAX_LOGS: "100000", PORT: "999999" });
  assert.equal(high.GPU_POLL_MS, 10000);
  assert.equal(high.MAX_LOGS, 500);
  assert.equal(high.PORT, 65535);

  const junk = buildConfig({ GPU_POLL_MS: "abc", MAX_LOGS: "abc", PORT: "abc" });
  assert.equal(junk.GPU_POLL_MS, 5000);
  assert.equal(junk.MAX_LOGS, 50);
  assert.equal(junk.PORT, 3000);
  assert.ok(junk.warnings.length >= 1);
});

test("security gates reject unsafe deployments", () => {
  const noSecret = buildConfig({ HOST: "127.0.0.1" });
  assert.match(validateConfig(noSecret).join(" "), /SESSION_SECRET/);

  const lanNoPass = buildConfig({ HOST: "0.0.0.0", SESSION_SECRET: "x".repeat(64) });
  assert.match(validateConfig(lanNoPass).join(" "), /PASSPHRASE/);

  const lanOk = buildConfig({ HOST: "0.0.0.0", SESSION_SECRET: "x".repeat(64), PASSPHRASE: "hunter2!" });
  assert.deepEqual(validateConfig(lanOk), []);

  const localOk = buildConfig({ HOST: "127.0.0.1", SESSION_SECRET: "x".repeat(64) });
  assert.deepEqual(validateConfig(localOk), []);
  assert.deepEqual(validateConfig(buildConfig({ HOST: "::1", SESSION_SECRET: "x" })), []);
});

test("weak secrets raise advisories without blocking startup", () => {
  const weak = buildConfig({ HOST: "0.0.0.0", SESSION_SECRET: "short", PASSPHRASE: "123" });
  const notes = advisories(weak).join(" ");
  assert.match(notes, /SESSION_SECRET is only/);
  assert.match(notes, /PASSPHRASE is shorter/);
  assert.match(notes, /plain HTTP/);
  assert.deepEqual(validateConfig(weak), [], "advisories are not fatal");
});

test("the miner binary default follows the platform", () => {
  assert.equal(buildConfig({}, { platform: "win32" }).MINER_EXE, "VerthashMiner.exe");
  assert.equal(buildConfig({}, { platform: "linux" }).MINER_EXE, "VerthashMiner");
  assert.equal(buildConfig({ MINER_EXE: "./custom" }, { platform: "linux" }).MINER_EXE, "./custom");
});

test("--protocol-dump is added once and never duplicated", () => {
  assert.equal(
    buildConfig({ MINER_ARGS: "-u w -P" }).MINER_ARGS.filter(a => a === "--protocol-dump").length,
    0
  );
  assert.equal(
    buildConfig({ MINER_ARGS: "-u w --protocol-dump" }).MINER_ARGS.filter(a => a === "--protocol-dump")
      .length,
    1
  );
});
