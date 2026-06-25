#!/usr/bin/env bash
#
# Headline ablation: does multi-agent consensus reduce run-to-run verdict flips?
#
# An llm_assisted judge flips borderline verdicts run-to-run (the LLM is not
# bit-deterministic even at temp=0). The thesis claim is that voting over K
# independent samples (the consensus judge) damps that churn. This runs the SAME
# llm_assisted config twice for each judge arm and compares verdict-stability:
#
#   arm A — single-LLM (--consensus-n 1, the baseline)
#   arm B — consensus  (--consensus-n K)
#
# Same corpus, same analyzers, same cases → a like-for-like comparison. Expect the
# consensus arm to show a LOWER verdict flip rate than single-LLM.
#
#   K=3 LIMIT=30 scripts/consensus-ablation.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
LIMIT="${LIMIT:-30}"; K="${K:-3}"; OUT="${OUT:-/tmp/consensus-ablation}"
export EVAL_STATIC_URL="${EVAL_STATIC_URL:-http://127.0.0.1:50061/mcp}"
export EVAL_DYNAMIC_URL="${EVAL_DYNAMIC_URL:-http://127.0.0.1:50062/mcp}"

rm -rf "$OUT"; mkdir -p "$OUT"/s1a "$OUT"/s1b "$OUT"/sca "$OUT"/scb

run () { # <subdir> <consensus-n>
  RESULTS_DIR="$OUT/$1" bun scripts/evaluate-corpus.ts llm_assisted --limit "$LIMIT" --consensus-n "$2"
}

echo "############ single-LLM (n=1) — run A ############"; run s1a 1
echo "############ single-LLM (n=1) — run B ############"; run s1b 1
echo "############ consensus (n=$K) — run A ############"; run sca "$K"
echo "############ consensus (n=$K) — run B ############"; run scb "$K"

S1A=$(ls -d "$OUT"/s1a/eval-* | head -1); S1B=$(ls -d "$OUT"/s1b/eval-* | head -1)
SCA=$(ls -d "$OUT"/sca/eval-* | head -1); SCB=$(ls -d "$OUT"/scb/eval-* | head -1)

echo; echo "════════════ SINGLE-LLM (n=1) stability ════════════"
bun scripts/verdict-stability.ts "$S1A" "$S1B"
echo; echo "════════════ CONSENSUS (n=$K) stability ════════════"
bun scripts/verdict-stability.ts "$SCA" "$SCB"
echo; echo "(lower verdict flip rate in the consensus arm ⇒ the judge damps run-to-run churn)"

# Paired significance: do the two judge arms differ on the SAME sites? Compare run-A
# of each arm site-by-site (McNemar). Stability is about run-to-run churn; this is
# about whether the consensus verdicts differ from single-LLM at all, with a p-value.
echo; echo "════════════ SINGLE-LLM vs CONSENSUS — McNemar (paired, run A) ════════════"
bun scripts/mcnemar-compare.ts "single=$S1A" "consensus=$SCA"
