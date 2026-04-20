#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

docker compose \
  --env-file "${ENV_FILE:-.env.example}" \
  -f docker-compose.thesis-demo.yml \
  up --build
