"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizePci, parseCudaDeviceList, createStreamReader, stripAnsi } = require("../../src/devices");
const { DEVICE_LIST_OUTPUT } = require("../helpers/fixtures");
const { LIMITS } = require("../../src/constants");

test("PCI ids from both tools normalise to the same key", () => {
  assert.equal(normalizePci("00000000:01:00.0"), "01:00:0");
  assert.equal(normalizePci("01:00:0"), "01:00:0");
  assert.equal(normalizePci("0000:08:00.0"), "08:00:0");
  assert.equal(normalizePci("AB:CD.E"), "ab:cd:e");
  assert.equal(normalizePci("garbage"), "garbage");
});

test("--device-list yields the CUDA section only", () => {
  const map = Object.create(null);
  parseCudaDeviceList(DEVICE_LIST_OUTPUT, map);
  assert.deepEqual({ ...map }, { "01:00:0": "0", "08:00:0": "1" });
});

test("devices without a PCI id are skipped rather than mismapped", () => {
  const map = Object.create(null);
  parseCudaDeviceList(
    ["CUDA devices:", "\tIndex: 0. Name: X. pcieId: not avilable", "\tIndex: 1. Name: Y. pcieId: 03:00:0"].join("\n"),
    map
  );
  assert.deepEqual({ ...map }, { "03:00:0": "1" });
});

test("generated-config style device blocks are understood", () => {
  const map = Object.create(null);
  parseCudaDeviceList(
    ["# CUDA Device config:", "# DeviceIndex: 2", "#    Name: RTX 4090", "#    PCIeId: 41:00:0"].join("\n"),
    map
  );
  assert.deepEqual({ ...map }, { "41:00:0": "2" });
});

test("empty and hostile device lists are handled", () => {
  const map = Object.create(null);
  assert.doesNotThrow(() => parseCudaDeviceList("", map));
  assert.doesNotThrow(() => parseCudaDeviceList("CUDA devices: None\n", map));
  assert.doesNotThrow(() => parseCudaDeviceList("\u0000\u0000\n".repeat(100), map));
  assert.deepEqual({ ...map }, {});
});

test("stripAnsi removes colour codes", () => {
  assert.equal(stripAnsi("\u001b[31mred\u001b[0m"), "red");
});

test("stream reader reassembles lines split across chunks", () => {
  const seen = [];
  const read = createStreamReader(line => seen.push(line), null, () => false);

  read("first line\nsec");
  read("ond line\r\nthird");
  read(" line\n");

  assert.deepEqual(seen, ["first line", "second line", "third line"]);
});

test("stream reader emits nothing until a newline arrives", () => {
  const seen = [];
  const read = createStreamReader(line => seen.push(line), null, () => false);
  read("partial");
  assert.deepEqual(seen, []);
  read("\n");
  assert.deepEqual(seen, ["partial"]);
});

test("stream reader never drops complete lines when the buffer overflows", () => {
  const seen = [];
  const read = createStreamReader(line => seen.push(line), null, () => false);

  const huge = "x".repeat(LIMITS.STREAM_BUFFER_BYTES + 1000);
  read(`${huge}\nkeepme\n`);

  assert.equal(seen.length, 2);
  assert.equal(seen[1], "keepme");
});

test("stream reader caps an unterminated line", () => {
  const read = createStreamReader(() => {}, null, () => false);
  for (let i = 0; i < 50; i++) read("z".repeat(64 * 1024));
  // No newline was ever seen: nothing emitted, and memory stayed bounded.
  assert.ok(process.memoryUsage().heapUsed < 512 * 1024 * 1024);
});

test("onFlush fires once per chunk and only when a client is attached", () => {
  let flushes = 0;
  let enabled = false;
  const read = createStreamReader(() => {}, () => flushes++, () => enabled);

  read("a\nb\nc\n");
  assert.equal(flushes, 0);

  enabled = true;
  read("d\ne\n");
  assert.equal(flushes, 1);
});

test("blank lines between records are ignored", () => {
  const seen = [];
  const read = createStreamReader(line => seen.push(line), null, () => false);
  read("\n\n\na\n\n\nb\n");
  assert.deepEqual(seen, ["a", "b"]);
});
