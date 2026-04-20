#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export MCP_STATIC_SERVER_URL="${MCP_STATIC_SERVER_URL:-http://localhost:8081/mcp}"
export MCP_DYNAMIC_SERVER_URL="${MCP_DYNAMIC_SERVER_URL:-http://localhost:8080/mcp}"
export MEMORY_LEAK_APP_WORKSPACE_ROOTS="${MEMORY_LEAK_APP_WORKSPACE_ROOTS:-$ROOT_DIR/demo/memory_leak_corpus}"
export MEMORY_LEAK_APP_ARTIFACT_DIR="${MEMORY_LEAK_APP_ARTIFACT_DIR:-$ROOT_DIR/results/app_scans}"

cd "$ROOT_DIR/MCP-Vul"

PYTHONPATH="$ROOT_DIR/mcp-memory-common/src:${PYTHONPATH:-}" \
python -m src.memory_leak_app.server \
  --host "${MEMORY_LEAK_APP_HOST:-127.0.0.1}" \
  --port "${MEMORY_LEAK_APP_PORT:-8090}"
