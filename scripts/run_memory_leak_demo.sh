#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_REPO="${1:-$ROOT_DIR/demo/memory_leak_corpus/simple_leak}"
RESULTS_DIR="${RESULTS_DIR:-$ROOT_DIR/results/demo}"

mkdir -p "$RESULTS_DIR"

export MCP_STATIC_SERVER_URL="${MCP_STATIC_SERVER_URL:-http://localhost:8081/mcp}"
export MCP_DYNAMIC_SERVER_URL="${MCP_DYNAMIC_SERVER_URL:-http://localhost:8080/mcp}"

cd "$ROOT_DIR/MCP-Vul"

PYTHONPATH="$ROOT_DIR/mcp-memory-common/src:${PYTHONPATH:-}" \
python -m src.memory_leak.control_plane "$TARGET_REPO" \
  --limit "${SCAN_LIMIT:-200}" \
  --build-command "${BUILD_COMMAND:-make CC=clang}" \
  --output "$RESULTS_DIR/report.json" \
  --markdown-output "$RESULTS_DIR/report.md" \
  --html-output "$RESULTS_DIR/report.html" \
  --snapshot-output "$RESULTS_DIR/snapshot.json" \
  --snapshot-mode "${SNAPSHOT_MODE:-orchestrated}"
