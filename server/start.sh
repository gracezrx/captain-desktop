#!/usr/bin/env bash
# Start Captain's backend: Mattermost + Postgres, one-time setup, then the bridge.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created server/.env from the example. Fill in the passwords and secrets, then run ./start.sh again."
  exit 1
fi

docker compose up -d postgres mattermost
node setup.mjs
# Recreate the bridge so it picks up the agent tokens setup wrote to .env.
docker compose up -d --build --force-recreate bridge
echo
echo "Captain backend is up:"
echo "  Mattermost  http://localhost:8065"
echo "  Bridge      http://localhost:8787/health"
