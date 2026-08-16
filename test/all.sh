#!/bin/sh
# Full suite: server modules, browser modules, and a real-snapshot render pass.
set -e
cd "$(dirname "$0")/.."

echo "── server ──────────────────────────────────────────"
node test/run.js

echo "── client ──────────────────────────────────────────"
node test/client.mjs

echo "── render ──────────────────────────────────────────"
node test/render.mjs

echo "All suites passed."
