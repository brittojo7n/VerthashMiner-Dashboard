"use strict";

function parseMinerUser(raw) {
  const source = raw == null ? "" : String(raw).trim();
  if (!source) return { wallet: "", worker: null };
  const dot = source.indexOf(".");
  if (dot === -1) return { wallet: source, worker: null };
  const wallet = source.slice(0, dot).trim();
  const worker = source.slice(dot + 1).trim();
  return { wallet, worker: worker || null };
}

module.exports = { parseMinerUser };
