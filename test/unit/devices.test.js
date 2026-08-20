"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizePci, parseCudaDeviceList, createStreamReader } = require("../../src/devices");

test("normalizePci: common bus-id formats converge", () => {
  assert.equal(normalizePci("00000000:01:00.0"), "01:00:0");
  assert.equal(normalizePci("01:00.0"), "01:00:0");
  assert.equal(normalizePci("01:00:0"), "01:00:0");
  assert.equal(normalizePci("5:3.0"), "05:03:0", "single digits padded");
  assert.equal(normalizePci("garbage"), "garbage");
});

test("parseCudaDeviceList: CUDA entries mapped, OpenCL ignored", () => {
  const out = `Listing devices\nCUDA devices:\n\tIndex: 0. Name: NVIDIA GeForce RTX 3060 pcieId: 01:00:0\n\tIndex: 1. Name: NVIDIA GeForce GTX 1660 SUPER pcieId: 06:00:0\nOpenCL devices:\n\tIndex: 0. Name: Intel UHD pcieId: 00:02:0\n`;
  const map = parseCudaDeviceList(out, Object.create(null));
  assert.equal(map["01:00:0"], "0");
  assert.equal(map["06:00:0"], "1");
  assert.equal(map["00:02:0"], undefined, "OpenCL section must not pollute the CUDA map");
});

test("parseCudaDeviceList: multi-line DeviceIndex/pcieId layout", () => {
  const out = `CUDA device config:\n\tDeviceIndex: 2\n\tpcieId: 00000000:41:00.0\n`;
  const map = parseCudaDeviceList(out, Object.create(null));
  assert.equal(map["41:00:0"], "2");
});

test("parseCudaDeviceList: unavailable devices skipped", () => {
  const out = `CUDA devices:\n\tIndex: 0. Name: NVIDIA GeForce RTX 3060 pcieId: 01:00:0\n\tIndex: 1. Name: GPU not avilable pcieId: 06:00:0\n`;
  const map = parseCudaDeviceList(out, Object.create(null));
  assert.equal(map["06:00:0"], undefined);
});

test("createStreamReader: splits chunks into lines, keeps remainder, drops \\r", () => {
  const lines = [];
  const reader = createStreamReader(l => lines.push(l), null, () => true, null);
  reader("one\r\ntwo\r\n");
  reader("partial");
  reader(" three\nfour\n");
  assert.deepEqual(lines, ["one", "two", "partial three", "four"]);
});

test("createStreamReader: flush only fires when parsing enabled", () => {
  let flushes = 0;
  let enabled = false;
  const reader = createStreamReader(() => {}, () => flushes++, () => enabled, null);
  reader("a\n");
  assert.equal(flushes, 0, "disabled -> no broadcast work while idle");
  enabled = true;
  reader("b\n");
  assert.equal(flushes, 1);
});

test("createStreamReader: unbounded single line is capped at STREAM_BUFFER_BYTES", () => {
  let seen = null;
  const reader = createStreamReader(l => { seen = l; }, null, () => true, null);
  const big = "x".repeat(200000);
  reader(big); // no newline yet, must not grow unbounded
  reader("\n");
  assert.ok(seen.length <= 65536 + 1);
});

test("createStreamReader: forward mirror receives raw chunks", () => {
  const forwarded = [];
  const reader = createStreamReader(() => {}, null, () => true, c => forwarded.push(c));
  reader("raw\n");
  assert.deepEqual(forwarded, ["raw\n"]);
});
