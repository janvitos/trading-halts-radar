#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "Node.js is required. Install Node.js 20 or newer, then run this script again."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' "npm is required. Install npm, then run this script again."
  exit 1
fi

if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"; then
  printf '%s\n' "Node.js 20 or newer is required. Current version: $(node --version)"
  exit 1
fi

printf '%s\n' "Installing or updating dependencies..."
npm install --no-bin-links

printf '%s\n' "Building the dashboard..."
node ./node_modules/typescript/bin/tsc
node ./node_modules/vite/bin/vite.js build

printf '%s\n' "Starting Trading Halts Radar..."
printf '%s\n' "Open http://localhost:${PORT:-8787}/ in your browser."
NODE_ENV=production node server/index.js
