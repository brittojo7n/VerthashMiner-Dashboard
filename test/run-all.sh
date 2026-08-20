#!/usr/bin/env bash
# Full verification sweep for the VerthashMiner dashboard.
#   test/run-all.sh          unit + e2e (zero dependencies)
#   test/run-all.sh --all    also run the browser FPS/visual harness (needs: cd test/browser && npm install)
set -uo pipefail
cd "$(dirname "$0")/.."
rc=0

echo "== unit tests =="
node --test $(ls test/unit/*.test.js test/unit/*.test.mjs) || rc=1

echo
echo "== end-to-end (real server + mock miner + mock nvidia-smi) =="
node test/e2e/run-e2e.js || rc=1

if [ "${1:-}" = "--all" ]; then
  echo
  echo "== browser harness (tablet emulation FPS + visual parity) =="
  if [ -d test/browser/node_modules ]; then
    (cd test/browser && node fps.js) || rc=1
    (cd test/browser && node visual.js) || rc=1
  else
    echo "skipped: run 'cd test/browser && npm install' first (downloads a private Chromium)"
  fi
fi

echo
if [ "$rc" = 0 ]; then echo "ALL SUITES PASSED"; else echo "SUITE FAILURES — see above"; fi
exit "$rc"
