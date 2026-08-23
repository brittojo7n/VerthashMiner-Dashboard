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

function workerFromPass(pass) {
  const value = pass == null ? "" : String(pass).trim();
  if (!value || /^x$/i.test(value) || value.includes("=")) return null;
  return value;
}

function resolveIdentity(flags) {
  const parsed = parseMinerUser(flags && flags.user);
  const worker = parsed.worker || workerFromPass(flags && flags.pass);
  return {
    wallet: parsed.wallet,
    worker,
    user: formatMinerUser({ wallet: parsed.wallet, worker })
  };
}

function minerUserSource(miner = {}) {
  if (miner.user) return miner.user;
  if (miner.worker) return `${miner.wallet || ""}.${miner.worker}`;
  return miner.wallet || "";
}

module.exports = { parseMinerUser, formatMinerUser, workerFromPass, resolveIdentity, minerUserSource };