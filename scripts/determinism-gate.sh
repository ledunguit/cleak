#!/usr/bin/env bash
#
# Tier-1 reproducibility gate: run the SAME eval config twice and assert the two
# runs produce byte-identical scoring. This guards the NON-LLM pipeline (static
# heuristic judge + pinned dynamic recipe + deterministic evidence capture +
# scoring) against code-level nondeterminism (map ordering, capture bugs, …).
#
# Use no_llm (the default) for a bitwise guarantee — the heuristic judge is pure.
# llm_assisted is NOT expected to pass (the LLM judge varies run-to-run even at
# temp=0); quantify that variance with `evaluate-corpus.ts --runs N` instead.
#
# The two runs write to DISTINCT dirs ($OUT/A, $OUT/B) so a coarse output stamp
# can never collide them into a self-compare (assert-determinism rejects that, and
# any errored/empty run, with exit 2).
#
# Usage:
#   scripts/determinism-gate.sh                         # no_llm, 30 cases, dynamic off
#   MODE=no_llm LIMIT=30 scripts/determinism-gate.sh --dynamic selective
#   EVAL_STATIC_URL=... EVAL_DYNAMIC_URL=... scripts/determinism-gate.sh
#
# Defaults assume the docker stack's MCP ports (static 50061, dynamic 50062).
set -euo pipefail

MODE="${MODE:-no_llm}"
LIMIT="${LIMIT:-30}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-/tmp/determinism-gate}"
export EVAL_STATIC_URL="${EVAL_STATIC_URL:-http://127.0.0.1:50061/mcp}"
export EVAL_DYNAMIC_URL="${EVAL_DYNAMIC_URL:-http://127.0.0.1:50062/mcp}"

rm -rf "$OUT"
mkdir -p "$OUT/A" "$OUT/B"
cd "$ROOT"

echo "── determinism gate: mode=$MODE limit=$LIMIT static=$EVAL_STATIC_URL ──"
echo "── run A ──"
RESULTS_DIR="$OUT/A" bun scripts/evaluate-corpus.ts "$MODE" --limit "$LIMIT" "$@" | tail -2
echo "── run B ──"
RESULTS_DIR="$OUT/B" bun scripts/evaluate-corpus.ts "$MODE" --limit "$LIMIT" "$@" | tail -2

A="$(ls -d "$OUT"/A/eval-* | head -1)"
B="$(ls -d "$OUT"/B/eval-* | head -1)"
echo "── assert (A=$A B=$B) ──"
bun scripts/assert-determinism.ts "$A/metrics.json" "$B/metrics.json"
