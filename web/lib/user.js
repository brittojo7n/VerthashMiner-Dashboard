function parseMinerUser(raw) {
  const source = raw == null ? "" : String(raw).trim();
  if (!source) return { wallet: "", worker: null };
  const dot = source.indexOf(".");
  if (dot === -1) return { wallet: source, worker: null };
  const wallet = source.slice(0, dot).trim();
  const worker = source.slice(dot + 1).trim();
  return { wallet, worker: worker || null };
}

function formatMinerUser({ wallet, worker }) {
  const w = wallet ? String(wallet).trim() : "";
  const wk = worker ? String(worker).trim() : "";
  return w ? (wk ? `${w}.${wk}` : w) : "";
}

function workerFromPass(pass) {
  const v = pass == null ? "" : String(pass).trim();
  if (!v || /^x$/i.test(v) || v.includes("=")) return null;
  return v;
}

function resolveIdentity(flags) {
  const parsed = parseMinerUser(flags && flags.user);
  const worker = parsed.worker || workerFromPass(flags && flags.pass);
  return { wallet: parsed.wallet, worker, user: formatMinerUser({ wallet: parsed.wallet, worker }) };
}

function minerUserSource(miner = {}) {
  if (miner.user) return miner.user;
  if (miner.worker) return `${miner.wallet || ""}.${miner.worker}`;
  return miner.wallet || "";
}

export { parseMinerUser, formatMinerUser, workerFromPass, resolveIdentity, minerUserSource };
