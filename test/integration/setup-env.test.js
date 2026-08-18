"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { ROOT } = require("../helpers/harness");
const { parseEnvFile, buildConfig, validateConfig } = require("../../src/config");

const SETUP = path.join(ROOT, "tools", "setup-test-env.js");

test("setup-test-env produces a runnable, valid environment", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vmd-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const output = execFileSync(
    process.execPath,
    [SETUP, "--dir", dir, "--size-mb", "1", "--port", "4067"],
    { cwd: ROOT, encoding: "utf8" }
  );

  assert.match(output, /Test environment ready/);
  assert.match(output, /PLACEHOLDER/, "the placeholder must be called out, not implied");

  const envPath = path.join(dir, ".env");
  assert.ok(fs.existsSync(envPath));

  const parsed = parseEnvFile(fs.readFileSync(envPath, "utf8"));
  assert.equal(parsed.PORT, "4067");
  assert.equal(parsed.HOST, "0.0.0.0");
  assert.equal(parsed.FORWARD_CONSOLE, "true");
  assert.equal(parsed.PASSPHRASE, "7654321abcdefg");
  assert.equal(parsed.SESSION_SECRET.length, 64, "a real random secret is generated");
  assert.match(parsed.MINER_ARGS, /vtc1qwddxt3rmwx00ev9yg4qcwpxnguw5zm7mwej2xk/);
  assert.match(parsed.MINER_ARGS, /verthash\.dat/);
  assert.match(parsed.MINER_ARGS, /--all-cu-devices/);

  const config = buildConfig(parsed);
  assert.deepEqual(validateConfig(config), [], "the generated config must pass the security gates");
  assert.equal(config.WALLET, "vtc1qwddxt3rmwx00ev9yg4qcwpxnguw5zm7mwej2xk");
  assert.ok(config.MINER_ARGS.includes("--protocol-dump"));

  const dataPath = path.join(dir, "miner", "verthash.dat");
  assert.ok(fs.existsSync(dataPath));
  assert.equal(fs.statSync(dataPath).size, 1024 * 1024);

  const minerName = process.platform === "win32" ? "VerthashMiner.cmd" : "VerthashMiner";
  assert.ok(fs.existsSync(path.join(dir, "miner", minerName)));
});

test("the generated miner stand-in answers --device-list like the real one", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vmd-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  execFileSync(process.execPath, [SETUP, "--dir", dir, "--size-mb", "0"], { cwd: ROOT });

  const minerName = process.platform === "win32" ? "VerthashMiner.cmd" : "VerthashMiner";
  const out = execFileSync(path.join(dir, "miner", minerName), ["--device-list"], {
    encoding: "utf8",
    shell: process.platform === "win32"
  });

  assert.match(out, /CUDA devices:/);
  assert.match(out, /pcieId: 01:00:0/);
});

test("the placeholder data file is deterministic", t => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "vmd-env-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "vmd-env-b-"));
  t.after(() => {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });

  execFileSync(process.execPath, [SETUP, "--dir", a, "--size-mb", "1"], { cwd: ROOT });
  execFileSync(process.execPath, [SETUP, "--dir", b, "--size-mb", "1"], { cwd: ROOT });

  const one = fs.readFileSync(path.join(a, "miner", "verthash.dat"));
  const two = fs.readFileSync(path.join(b, "miner", "verthash.dat"));
  assert.ok(one.equals(two), "same input must yield the same file");
});
