"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildConfig, validateConfig, advisories, parseEnvFile, splitArgs, clampGpuPollMs } = require("../../src/config");

const base = { PORT: "3000", HOST: "127.0.0.1", SESSION_SECRET: "x".repeat(64), MINER_CWD: "miner", MINER_EXE: "VerthashMiner.exe", MINER_ARGS: "-u VkcAbC.worker1 -o stratum+tcp://pool:9172 --all-cu-devices" };

test("buildConfig: defaults and forced --protocol-dump", () => {
  const c = buildConfig({ ...base });
  assert.ok(c.MINER_ARGS.includes("--protocol-dump"), "protocol dump force-added for JSON reject parsing");
  assert.equal(c.GPU_POLL_MS, 5000);
  assert.equal(c.MINER_EXE, "VerthashMiner.exe");
});

test("buildConfig: no duplicate --protocol-dump if user passed -P", () => {
  const c = buildConfig({ ...base, MINER_ARGS: "-u w -P" });
  assert.equal(c.MINER_ARGS.filter(a => a === "--protocol-dump" || a === "-P").length, 1);
});

test("buildConfig: wallet extraction strips worker suffix", () => {
  assert.equal(buildConfig({ ...base }).WALLET, "VkcAbC");
  const noWorker = buildConfig({ ...base, MINER_ARGS: "-u VkcPlain --all-cu-devices" });
  assert.equal(noWorker.WALLET, "VkcPlain");
});

test("buildConfig: quoted args and --device selection map", () => {
  const c = buildConfig({ ...base, MINER_ARGS: '-u w --cu-devices "1,3" --verthash-data "C:\\path with space\\v.dat"' });
  assert.deepEqual(c.DEVICE_SELECTION.cu, [1, 3]);
  assert.ok(c.MINER_ARGS.includes("C:\\path with space\\v.dat"));
  const all = buildConfig({ ...base });
  assert.equal(all.DEVICE_SELECTION.cu, null, "--all-cu-devices -> null (every worker slot matches)");
  const none = buildConfig({ ...base, MINER_ARGS: "-u w" });
  assert.equal(none.DEVICE_SELECTION.cu, null, "no selection flag -> identity mapping");
});

test("buildConfig: GPU poll clamp 3000..10000", () => {
  assert.equal(clampGpuPollMs(500), 3000);
  assert.equal(clampGpuPollMs(99999), 10000);
  assert.equal(clampGpuPollMs(7000), 7000);
  assert.equal(clampGpuPollMs("junk"), 5000);
  const c = buildConfig({ ...base, GPU_POLL_MS: "1000" });
  assert.equal(c.GPU_POLL_MS, 3000);
  assert.ok(c.warnings.some(w => w.includes("clamped")));
});

test("buildConfig: port clamping and advisories", () => {
  const c = buildConfig({ ...base, PORT: "99999" });
  assert.equal(c.PORT, 65535);
  assert.ok(advisories(c).some(a => a.includes("PORT")));
  const weak = buildConfig({ ...base, SESSION_SECRET: "short", PASSPHRASE: "abc" });
  assert.ok(advisories(weak).some(a => a.includes("SESSION_SECRET")));
  assert.ok(advisories(weak).some(a => a.includes("PASSPHRASE")));
});

test("validateConfig: fail-fast gates", () => {
  assert.equal(validateConfig(buildConfig({ ...base })).length, 0);
  assert.ok(validateConfig(buildConfig({ ...base, SESSION_SECRET: "" })).length > 0, "missing secret is fatal");
  const lan = buildConfig({ ...base, HOST: "0.0.0.0", PASSPHRASE: "" });
  assert.ok(validateConfig(lan).some(m => m.includes("PASSPHRASE")), "LAN without passphrase is fatal");
  const lanOk = buildConfig({ ...base, HOST: "0.0.0.0", PASSPHRASE: "hunter2hunter2" });
  assert.equal(validateConfig(lanOk).length, 0);
});

test("parseEnvFile: quotes, inline comments, blank lines", () => {
  const env = parseEnvFile(`
# comment
A=1
B = "quoted value"
C='single'
D=bare # trailing comment
E=
`);
  assert.deepEqual([env.A, env.B, env.C, env.D, env.E], ["1", "quoted value", "single", "bare", ""]);
});

test("splitArgs: whitespace and quoted tokens", () => {
  assert.deepEqual(splitArgs('-u wallet -o "stratum+tcp://a b:1"'), ["-u", "wallet", "-o", "stratum+tcp://a b:1"]);
  assert.deepEqual(splitArgs(""), []);
});
