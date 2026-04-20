#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="${1:-$ROOT_DIR/demo/memory_leak_corpus/corpus_manifest.json}"
RESULTS_DIR="${RESULTS_DIR:-$ROOT_DIR/results/corpus}"

export MCP_STATIC_SERVER_URL="${MCP_STATIC_SERVER_URL:-http://localhost:8081/mcp}"
export MCP_DYNAMIC_SERVER_URL="${MCP_DYNAMIC_SERVER_URL:-http://localhost:8080/mcp}"

cd "$ROOT_DIR/MCP-Vul"

PYTHONPATH="$ROOT_DIR/mcp-memory-common/src:${PYTHONPATH:-}" \
python -m src.memory_leak.batch_runner "$MANIFEST" \
  --output-dir "$RESULTS_DIR" \
  --limit "${SCAN_LIMIT:-500}" \
  --snapshot-mode "${SNAPSHOT_MODE:-orchestrated}"
