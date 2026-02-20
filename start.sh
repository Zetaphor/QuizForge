#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

if [ ! -f .env ]; then
  echo "Creating .env from .env.example..."
  cp .env.example .env
fi

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "yt-dlp is required but not installed. Install it and rerun."
  exit 1
fi

echo "Ensuring Prisma client and SQLite schema are ready..."
npm run prisma:generate
npm run prisma:push
npm run tailwind:build

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-3000}"

echo "Starting server on LAN at http://${HOST}:${PORT}"
echo "If needed, allow this port in your firewall."

HOST="$HOST" PORT="$PORT" npm run dev
