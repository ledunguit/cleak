#!/usr/bin/env bash
#
# Validation ablation: does consensus.earlyStop change verdicts, and does it
# actually save LLM calls/tokens?
#
# isDecisionLocked() is proven mathematically (exhaustive equivalence tests,
# packages/common/tests/analysis/consensus-judge.test.ts) to make the SAME
# flag/no-flag call as sampling all n — but that's a unit-level proof against
# scripted verdicts, never run against a real provider/real bundles. This
# script is the real-world check docs/EVALUATION.md's Tier-2 methodology
# requires before recommending an opt-in judge-behavior knob (same shape as
# consensus-ablation.sh, which validated consensus itself the same way):
#
#   arm A — consensus (--consensus-n K), earlyStop OFF (baseline)
#   arm B — consensus (--consensus-n K), earlyStop ON
#
# Same corpus, same analyzers, same cases → verdicts should be IDENTICAL
# (that's what isDecisionLocked guarantees) while arm B's `metrics.json`
# reports fewer/equal LLM calls and tokens.
#
#   K=3 LIMIT=30 scripts/earlystop-ablation.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
LIMIT="${LIMIT:-30}"; K="${K:-3}"; OUT="${OUT:-/tmp/earlystop-ablation}"
export EVAL_STATIC_URL="${EVAL_STATIC_URL:-http://127.0.0.1:50061/mcp}"
export EVAL_DYNAMIC_URL="${EVAL_DYNAMIC_URL:-http://127.0.0.1:50062/mcp}"

rm -rf "$OUT"; mkdir -p "$OUT"/off "$OUT"/on

run () { # <subdir> <extra-flag>
  # --no-judge-cache: an unrelated but equally fatal-if-forgotten interaction —
  # see consensus-ablation.sh's identical comment. Both arms must independently
  # hit the real judge, not a cached verdict from a prior run of this script.
  RESULTS_DIR="$OUT/$1" pnpm exec tsx scripts/evaluate-corpus.ts llm_assisted --limit "$LIMIT" --consensus-n "$K" --no-judge-cache $2
}

echo "############ earlyStop OFF (baseline, arm A) ############"; run off "--no-consensus-early-stop"
echo "############ earlyStop ON  (arm B)           ############"; run on "--consensus-early-stop"

OFF=$(ls -d "$OUT"/off/eval-* | head -1); ON=$(ls -d "$OUT"/on/eval-* | head -1)

echo; echo "════════════ earlyStop OFF vs ON — McNemar (paired) ════════════"
echo "(isDecisionLocked guarantees early-stop matches full-sampling for the SAME drawn"
echo "samples — arm A and arm B are two INDEPENDENT runs at temperature>0, so they draw"
echo "different samples and CAN legitimately disagree on genuinely borderline sites, same"
echo "as any two independent consensus runs would, see consensus-ablation.sh. Expect"
echo "discordance comparable to that baseline run-to-run noise, not literally zero — the"
echo "real question McNemar answers here is whether earlyStop adds a NEW, systematic bias"
echo "on top of that existing noise floor.)"
pnpm exec tsx scripts/mcnemar-compare.ts "off=$OFF" "on=$ON"

echo; echo "════════════ Token / call cost ════════════"
python3 -c "
import json
off = json.load(open('$OFF/metrics.json'))
on = json.load(open('$ON/metrics.json'))
def tok(m):
    c = m.get('cost', {})
    return c.get('totalInputTokens', 0) + c.get('totalOutputTokens', 0)
print(f\"  earlyStop OFF: {tok(off)} tokens\")
print(f\"  earlyStop ON:  {tok(on)} tokens\")
if tok(off) > 0:
    pct = 100 * (tok(off) - tok(on)) / tok(off)
    print(f\"  savings: {pct:.1f}%\")
" 2>/dev/null || echo "  (inspect $OFF/metrics.json and $ON/metrics.json manually — field names may differ)"
