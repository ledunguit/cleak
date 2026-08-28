#!/usr/bin/env bash
# MemHint corpus eval driver — no_llm baseline + llm_assisted x3, unattended.
#
# Designed to run standalone inside a tmux session (survives an SSH/tunnel
# drop) on a host with the analyzers running NATIVELY (not Docker) — written
# for thesis-wsl2, but portable to any Linux host with node/pnpm/clang/
# valgrind installed and this repo checked out.
#
# Usage:
#   tmux new-session -d -s driver "bash -ilc $(pwd)/scripts/memhint-eval-driver.sh"
#   tmux attach -t driver          # to watch live
#   tail -f /tmp/memhint-driver.log
#
# Prerequisites (one-time, NOT done by this script):
#   - `cleak config set provider deepseek-direct` (or another llm.endpoints
#     profile) with a real apiKey — verify: cleak config get | grep provider
#   - `cleak config set analyzerRoot "$(pwd)"` — MUST equal the repo's
#     absolute path on THIS host. Left at the default `/workspace` (the
#     Docker-mount convention) this driver's dynamic stage silently finds
#     zero candidates: pathResolver.ts maps every path through analyzerRoot,
#     and a native (non-Docker) host has no `/workspace` to map onto.
#   - `demo/memhint/memhint_bugs.json` present (checked into git); the
#     driver runs `scripts/memhint/ingest.ts` itself if `demo/memhint/cases`
#     is missing (clones ~6 real repos — network + few minutes).
#
# --- 2026-08-28 OOM postmortem (why this script looks the way it does) ---
# The static-analyzer was OOM-killed by the Linux kernel TWICE while parsing
# the `redis` case (2235 files) — anon-rss hit ~14GB both times, even after
# halving STATIC_PARSER_WORKERS (8->4) and capping the main thread's V8 heap
# (--max-old-space-size). Root cause is almost certainly NATIVE memory
# (tree-sitter's C parse trees live outside the V8 heap, so
# --max-old-space-size can't bound them) not being reclaimed across a
# long-lived process handling many large files — not something worth
# chasing down mid-thesis-crunch. Mitigation instead of a fix:
#   1. --concurrency 1, so at most one large repo is in flight at a time.
#   2. STATIC_PARSER_WORKERS=2 + STATIC_PARSER_CACHE_MAX_MB=128 (smaller
#      footprint per worker/cache — reduces blast radius, does not prevent
#      the underlying leak).
#   3. Every attempt starts a FRESH static-analyzer process (clean process =
#      memory reset) and uses `--resume`, which skips already-scored cases
#      via the per-case disk cache under --out-dir/<run>. A crash costs at
#      most the ONE case that was mid-flight, not the whole run.
#   4. Up to 8 retry attempts per Run before giving up loudly (FATAL, not a
#      silently-partial result).
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(pwd)"

export EVAL_STATIC_URL=http://127.0.0.1:50061/mcp
export EVAL_DYNAMIC_URL=http://127.0.0.1:50062/mcp
export LLM_PROVIDER=${LLM_PROVIDER:-deepseek-direct}
export STATIC_PARSER_CACHE_MAX_MB=128

LOG=/tmp/memhint-driver.log
step() { echo "== [$(date '+%F %T')] $*" | tee -a "$LOG"; }

check_config() {
  python3 - "$REPO_ROOT" <<'EOF'
import json, sys
repo = sys.argv[1]
p = f"{__import__('os').environ['HOME']}/.config/cleak/config.json"
c = json.load(open(p))
root = c.get("analyzerRoot")
if root != repo:
    print(f"FATAL: analyzerRoot={root!r} != repo root {repo!r} — "
          f"run: cleak config set analyzerRoot \"{repo}\"")
    sys.exit(1)
prov = c.get("provider")
ep = (c.get("endpoints") or {}).get(prov, {})
if not (ep.get("apiKey") or (ep.get("llm") or {}).get("apiKey")):
    print(f"FATAL: provider={prov!r} has no apiKey configured")
    sys.exit(1)
print(f"config OK: analyzerRoot={root} provider={prov}")
EOF
}

ensure_analyzers() {
  if ! ss -ltn | grep -q ':50061'; then
    tmux kill-session -t static 2>/dev/null
    if [ ! -f dist/apps/static-analyzer/main.js ]; then
      bash -ilc 'pnpm --filter static-analyzer build' >>"$LOG" 2>&1
    fi
    tmux new-session -d -s static "bash -ilc 'cd $REPO_ROOT && STATIC_PARSER_WORKERS=2 STATIC_PARSER_CACHE_MAX_MB=128 node --max-old-space-size=3072 dist/apps/static-analyzer/main.js 2>&1 | tee -a /tmp/static-analyzer.log'"
  fi
  if ! ss -ltn | grep -q ':50062'; then
    tmux kill-session -t dynamic 2>/dev/null
    if [ ! -f dist/apps/dynamic-analyzer/main.js ]; then
      bash -ilc 'pnpm --filter dynamic-analyzer build' >>"$LOG" 2>&1
    fi
    # Root package.json declares "type": "module"; the dynamic-analyzer's
    # webpack build (unlike static-analyzer's) doesn't emit an override, so a
    # plain `node dist/apps/dynamic-analyzer/main.js` from a full checkout
    # (ambient package.json above dist/) gets misdetected as ESM and crashes
    # on `require()`. Static-analyzer's own webpack.config.js writes this
    # marker for itself (see the file's own comment); dynamic-analyzer's
    # doesn't, so write it here.
    printf '{\n  "type": "commonjs"\n}\n' > dist/apps/dynamic-analyzer/package.json
    tmux new-session -d -s dynamic "bash -ilc 'cd $REPO_ROOT && WORKSPACE_ROOT=$REPO_ROOT node dist/apps/dynamic-analyzer/main.js 2>&1 | tee -a /tmp/dynamic-analyzer.log'"
  fi
  for _ in $(seq 1 90); do
    ss -ltn | grep -q ':50061' && ss -ltn | grep -q ':50062' && return 0
    sleep 2
  done
  return 1
}

# Force a genuinely fresh static-analyzer process (used between retry
# attempts — a lingering zombie on the port would otherwise defeat the
# "clean process = memory reset" mitigation).
force_restart_static() {
  tmux kill-session -t static 2>/dev/null
  pkill -f 'dist/apps/static-analyzer/main.js' 2>/dev/null
  sleep 1
  ensure_analyzers
}

ensure_corpus() {
  if [ ! -d demo/memhint/cases ] || [ -z "$(ls -A demo/memhint/cases 2>/dev/null)" ]; then
    step "MemHint corpus not materialized — running ingest (clones ~6 repos)"
    pnpm exec tsx scripts/memhint/ingest.ts >/tmp/memhint-ingest.log 2>&1 \
      || { step "FATAL: memhint ingest failed — see /tmp/memhint-ingest.log"; exit 1; }
  fi
}

revalidate() {
  pnpm exec tsx scripts/corpus/validate-corpus.ts --corpus demo/memhint \
    --skip-compile --strict-labels --write-lock demo/memhint.lock.json \
    >/tmp/memhint-validate.log 2>&1
  local rc=$?
  tail -4 /tmp/memhint-validate.log >>"$LOG"
  grep -q 'quarantined(HARD) 0' demo/memhint/corpus_validation_report.md || return 1
  return $rc
}

run_with_retry() {
  # $1 = label, $2 = out-dir, $3 = success-check-file (relative to out-dir),
  # remaining args = the evaluate-corpus.ts command
  local label=$1 outdir=$2 checkfile=$3
  shift 3
  for attempt in 1 2 3 4 5 6 7 8; do
    step "$label attempt $attempt"
    force_restart_static
    "$@" >/tmp/memhint-"${label// /_}".log 2>&1
    tail -8 /tmp/memhint-"${label// /_}".log >>"$LOG"
    if [ -f "$outdir/$checkfile" ] && grep -q '"ranOk": 19' "$outdir/$checkfile" 2>/dev/null; then
      step "$label complete on attempt $attempt"
      return 0
    fi
    step "$label attempt $attempt incomplete — retrying"
  done
  step "FATAL: $label never completed after 8 attempts — see /tmp/memhint-${label// /_}.log"
  return 1
}

step "driver start (commit $(git rev-parse --short HEAD))"
check_config || exit 1
ensure_corpus
ensure_analyzers || { step "FATAL: analyzers did not come up"; exit 1; }
step "analyzers up (50061 + 50062)"

step "validate + write-lock (pristine corpus)"
revalidate || { step "FATAL: validation failed — see /tmp/memhint-validate.log"; exit 1; }

OUT1=results/memhint-no_llm-2026-08-28
run_with_retry "Run1 no_llm" "$OUT1" "metrics.json" \
  pnpm exec tsx scripts/evaluate-corpus.ts no_llm --corpus demo/memhint \
    --enrich --dynamic selective --concurrency 1 --resume --out-dir "$OUT1" \
  || exit 1

step "post-Run-1 re-validate/re-lock before Run 2"
revalidate || { step "FATAL: post-Run-1 re-validation failed"; exit 1; }

OUT2=results/memhint-llm_assisted-2026-08-28
run_with_retry "Run2 llm_assisted" "$OUT2" "run-3/metrics.json" \
  pnpm exec tsx scripts/evaluate-corpus.ts llm_assisted --corpus demo/memhint \
    --enrich --dynamic selective \
    --static-tools candidateScan,functionSummary,pathConstraints,interproceduralFlow \
    --no-tool-select --strategy off --consensus-n 1 --no-judge-cache \
    --runs 3 --concurrency 1 --resume --out-dir "$OUT2" \
  || exit 1

step "ALL DONE — results in $OUT1 and $OUT2"
