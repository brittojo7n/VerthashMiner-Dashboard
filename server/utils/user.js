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

function formatMinerUser(identity) {
  const wallet = identity && identity.wallet ? String(identity.wallet).trim() : "";
  const worker = identity && identity.worker ? String(identity.worker).trim() : "";
  if (!wallet) return "";
  return worker ? `${wallet}.${worker}` : wallet;
}

module.exports = { parseMinerUser, formatMinerUser };
