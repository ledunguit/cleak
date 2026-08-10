# Current Status

_Last updated: 2026-08-10_

## Standing goal (verbatim, from the user)

> "Chúng ta phải tìm hết các bugs, sửa hết chúng và chạy được hoàn toàn flow cho
> một project thật, không phải chỉ chạy được, mà phải đủ, đúng, tối ưu chi phí,
> thời gian chạy, harness của chúng ta phải cân bằng các yếu tố, nhưng mục tiêu
> là phải tìm ra leak thật."

Breakdown: (1) find and fix all real bugs, (2) get the full `llm_assisted`
(+Stage B2) flow running completely and correctly on real projects — not just
"doesn't crash", (3) optimize cost/runtime, (4) balance those factors, (5) the
pipeline must actually find real memory leaks.

This file exists so a fresh session can pick up without re-deriving context.
Git history (`git log`) is now the authoritative detail record — this file is
a high-level index into it, not a duplicate.

## Corpora available for evaluation

- **Juliet CWE-401** (NIST SARD, synthetic, self-contained `main()` runs both
  good/bad paths) — 1658 cases, the deterministic baseline.
- **LAMeD** (EASE 2025, peer-reviewed, `docs/DATASETS.md`) — 41 cases across 7
  real C projects (curl, libtiff, cjson, libsolv, libxml2, libssh2, rabbitmq-c).
- **MemHint-derived** (this session, `demo/memhint/memhint_bugs.json`) — 19
  cases across 6 projects (vim, tmux, redis, curl, openssl, freerdp), an
  independently-reconstructed ground truth (MemHint's own 54-bug list isn't
  published).
- `demo/real_projects/` and `demo/memory_leak_corpus/` (hand-authored toy
  corpora) were **removed** — not credible evidence for thesis-level results.

## What's proven so far

- **MemHint full 19-case `no_llm --enrich` run, post-fix: 19/19 scored, 0
  errors.** Recall 42.3% (11/26), precision 100% (0 FP) — up from a 27.3%
  baseline before this session's fixes, same 0 FP. Confirmed via real load
  test that the static-analyzer worker-pool fix (see below) eliminates the
  MCP timeout failures a full run used to hit (9/19 cases timed out before
  the fix; 0/19 after, modulo one transient OOM investigated and fixed
  mid-run — see the worker-pool commit).
- **LAMeD 41-case `llm_assisted` run (pre-this-session's discovery-bug fix):**
  TP=7 FP=0 FN=37, Precision 100% / Recall 15.9% / F1 0.2745. Below the
  `no_llm --enrich` baseline (29.5%) — **not yet re-run with the
  `computeBundleId` fix**, which is expected to raise this materially (see
  "Pending" below — the bug silently collapsed ~90% of candidates on
  non-Juliet repos).
- **Juliet 30-case stratified sample, post-fix:** 30/30 scored, 0 errors,
  P 77.4% / R 72.7% / F1 0.750 — confirms none of this session's changes
  (worker pool, judge hardening, bundleId fix) regressed the synthetic
  baseline. Full 1658-case run not yet done.
- A single-case proof (historical, libtiff) confirmed the full HYBRID
  pipeline (Stages A→B→B2→C→D) finds a real leak end-to-end through the
  LLM-orchestrated path, not just the static-only path.

## Real bugs found & fixed (all committed — see `git log` for exact diffs)

1. **`computeBundleId` used a truncating pseudo-hash, not a real hash**
   (`candidateState.ts`) — for any `allocation_site` longer than 16 chars
   (every real-project path), it kept only the first 6 + last 10 characters,
   discarding the line number and most of the path. Candidates in different
   files sharing a path prefix + allocator-name suffix collapsed onto the
   identical bundleId; `CandidateManager.ingest()` silently keeps only the
   first one. Confirmed on curl_1098e104: 622 raw candidates → 65 surviving
   bundles pre-fix, 622/622 post-fix. **This is the single highest-impact fix
   found this session** — it explains why every prior full-corpus recall
   number on a real (non-Juliet) project was measured against a candidate
   pool silently truncated to roughly 1/10th its true size.
2. **static-analyzer parsed every file synchronously on the main thread** —
   any concurrent MCP call queued behind it; a 19-case MemHint run at default
   concurrency timed out on 9/19 of the largest repos. Moved to a Piscina
   worker-thread pool (`STATIC_PARSER_WORKERS`).
3. **MCP client connection-sharing bug** (`scanController.ts`) — one shared
   client across N concurrent discovery workers meant one worker's
   retry-triggered `close()` killed every sibling request in flight. Each
   worker now gets its own client. Permanent discovery diagnostics
   (files walked/read-failed/scan-failed/zero-candidate/raw-vs-ingested) were
   added alongside so a future silent candidate drop is visible immediately.
4. **Judge precision-gate over-trusted a blind dynamic-clean run** — a binary
   that ran OK with no correlated leak found could override strong static
   evidence (unpaired alloc/free, path-sensitive leak, ownership issue).
   Fixed in `heuristic-judge.ts`; a companion bug had 5 static signals reading
   from a dead context param in `no_llm` mode. `llmJudge.ts` also gained a
   safety net so a correlated dynamic-confirmed leak can't be dismissed as
   `false_positive` with no static context.
5. **LLM streaming transport had no absolute deadline** — `idleTimeoutMs`
   resets on any received byte including SSE heartbeats, so a gateway that
   keeps the connection alive while the model is stuck could hang forever.
   Added `maxTotalMs`, armed once per attempt.
6. **Corpus hash / LOC count polluted by build artifacts** — `harness-utils.ts`
   recursed into build trees the dynamic worker generates in-place, causing
   spurious "corpus drifted" gate failures and inflating the FP/KLOC
   denominator with generated code.
7. **Docker resource limits caused an OOM crash-loop, reverted** — an initial
   `deploy.resources.limits` (cpus/memory) guess made the static-analyzer
   container actively unreliable under real load; removed rather than kept
   as a wrong guess. `STATIC_PARSER_WORKERS`/`DYNAMIC_MAX_CONCURRENT_RUNS`
   are now sized empirically for this host's ~8GB Docker VM, documented
   inline as host-specific, not a profiled universal constant.

## New capability this session: token cost tracking

Token accounting was correct at the provider layer (split input/output) but
lost that split at the report boundary, and two real LLM call sites
(allocator profiler, strategist) never reported usage at all. Fixed
end-to-end: `RunConfig.pricing` (user-filled per-model $/1M-token table, no
baked-in defaults — `cleak config set pricing.<modelId>.inputPerMillion
<price>`), `computeCostUsd()` (never reports a silent $0 for an unpriced
model), and split tokens + cost surfaced in `report.md`/`metrics.csv`/
`metrics.json`/`tables.tex`. Verified against a real provider run: report.md's
`$0.23` matched the hand-computed cost from the configured price exactly.

## Pending / next steps

1. **Re-run LAMeD full 41-case `llm_assisted` with the `computeBundleId` fix**
   — the current 15.9% recall number predates it and is very likely stale
   (understated). This is the highest-value next run.
2. **MemHint Bước 4/5** (see task tracker): the 19-case audit is done for
   `no_llm`; `llm_assisted` full run + docs write-up (`docs/DATASETS.md`,
   `paper/de-cuong.md`) still pending.
3. **Juliet full 1658-case run** not yet done (only a 30-case sample verified
   post-fix) — cheap, worth doing before citing any Juliet-wide number.
4. **Consensus gate decision (LAMeD, from the earlier session): still open.**
   Gate rule fired (`recall_llm_assisted=0.159 <= 0.295`) but launch was
   never started, pending a user choice between (A) borderline-band-only
   (~21k tokens, cheap), (B) full-corpus ×3 (~3.5M tokens, multi-hour), or
   (C) skip. This decision predates the `computeBundleId` fix, so it may be
   worth re-evaluating after LAMeD is re-run with the fix (recall/borderline
   share will likely change).
5. **Docker resource limits**: still no `deploy.resources.limits` — needs
   real RSS profiling under load before attempting one again (see bug #7).

## Source of truth

- **Git history** — every fix above is its own commit with a full
  explanation; `git log --oneline` for the index.
- `docs/ARCHITECTURE.md` §8 — analyzer internals, including the worker-pool
  and concurrency-limiter design.
- `docs/OPERATIONS.md` §6 — env vars (`STATIC_PARSER_WORKERS`,
  `DYNAMIC_MAX_CONCURRENT_RUNS`) and the pricing config example.
- `docs/DATASETS.md` — corpus provenance and rebuild instructions.
- `docs/BASELINE-COMPARISON.md` — scoring convention for positive-only corpora
  (LAMeD, MemHint): recall + FP count, not precision/specificity/MCC.
