# Current Status

_Last updated: 2026-08-11 (return-value ownership + multi-hop + STL container ownership-correlation fix, same day later session + re-verified full Juliet no_llm run)_

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
- **Juliet full 1658-case `no_llm` run, post-fix (2026-08-10):** 1658/1658
  scored, 0 errors, 0 skipped — the worker-pool fix and every other change
  this session hold up across the whole corpus, not just a sample. Overall
  P 52.0% / R 38.6% / F1 0.443 / MCC 0.128 (TP 994, FP 918, FN 1584, TN 2541).
  Lower than the earlier 30-case stratified sample (P 77.4% / R 72.7%) —
  expected: the sample was evenly stratified across 10 functional variants,
  the full corpus is heavily skewed (`new` alone is 588/1658 cases) and
  includes harder variants underrepresented in the sample. This is the
  `no_llm` heuristic-only baseline; `llm_assisted` full run not yet done.
- **Juliet full 1658-case `no_llm` run, post cross-function/cross-file
  ownership-correlation fix (2026-08-11):** 1658/1658 scored, 0 errors.
  Overall **P 55.6% / R 47.5% / F1 0.512 / MCC 0.206** (TP 1225, FP 978,
  FN 1353, TN 2580) — up from the 2026-08-10 baseline directly above on
  every headline metric (P +3.6pp, R +8.9pp, F1 +0.069, MCC +0.078).
  Verified the improvement is precisely scoped: flow-variant 01-18/31-34
  (same-function leaks) are **byte-identical** to the pre-fix run (zero
  regression), while flow-variant ≥21 (cross-function/cross-file leaks —
  Juliet's own "sink functions are in a separate file from sources"
  convention) improved from P 48.6%/R 28.0%/F1 0.355 to
  **P 55.6%/R 41.5%/F1 0.475**. `determinism-gate.sh` still passes
  (bit-for-bit). Root cause + fix: see the "cross-function/cross-file
  ownership correlation" entry below.
- **Juliet full 1658-case `no_llm` run, post return-value-ownership +
  multi-hop + container-transport fix (2026-08-11, same day, later
  session):** 1658/1658 scored, 0 errors. Overall **P 64.3% / R 54.1% /
  F1 0.587 / MCC 0.327** (TP 1395, FP 776, FN 1183, TN 2683) — up from the
  cross-file-ownership baseline directly above on every headline metric
  (P +8.7pp, R +6.6pp, F1 +0.075, MCC +0.121 — MCC up more than 50%
  relative). `determinism-gate.sh` LIMIT=30 gate: `{tp:34,fp:4,fn:4,tn:84}`
  (up from `{tp:29,fp:7,fn:9,tn:81}`), still bit-for-bit deterministic.
  Verified precisely scoped again: flow-variant 01-18/31-34/21/22/41
  (already fixed/clean) stayed **byte-identical**; the newly-targeted groups
  (42, 61, 72/73/74) improved sharply (e.g. 42: fp 6→0, fn 21→2; 72-74:
  fp 19→6, fn 49→16 each); 51-54 (multi-hop) saw FP collapse (52/53/54:
  fp 52→6) with **FN unchanged by design** — the fix deliberately attributes
  the synthesized sink candidate to the chain's TERMINAL function only, not
  every pass-through hop, which differs from Juliet's own ground-truth
  labeling convention (it flags every hop, including pure forwarders) — a
  real, understood precision/ground-truth-matching trade-off, not a defect.
  Groups NOT in this fix's scope (43-45, 62-68, 81-84) stayed unchanged as
  expected — see "Known limitations" below.
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
8. **Cross-function/cross-file ownership was invisible to both the heuristic
   judge and candidate discovery** — two coupled bugs, found via the full
   Juliet `no_llm`/`llm_assisted` runs (100% of sampled FP/FN correlated with
   Juliet flow-variant ≥21, "sink functions are in a separate file from
   sources"): (a) **FP** — `isFreedViaCallee`'s cross-function free check
   (`heuristic-leak-analysis.ts`) only searched the CANDIDATE's own single
   file for the freeing callee's definition, so ownership handed off to a
   sink function defined in a sibling file was scored a confident
   `CONFIRMED_LEAK`, high enough to never escalate to the LLM judge (which
   already has the right prompt rule for this — it just never got reached);
   (b) **FN** — the F3 synthetic-parameter-candidate mechanism
   (`candidate-scan.service.ts`/`exit-path-analyzer.ts`) required a pointer
   parameter to be freed on **at least one** path before generating a
   candidate at all, so a sink that never frees on ANY path (a pure
   unconditional-loss leak, e.g. Juliet's `badSink`) never became a candidate
   — guaranteed FN regardless of judge quality. Fixed by adding ONE new
   deterministic pass, `CallGraphService.correlateOwnership()` (extends the
   existing project-wide `callGraph` MCP tool, narrow-scoped: only fires when
   a call site demonstrably passes an already-tracked heap allocation, never
   for an ordinary borrow-only parameter), wired unconditionally into
   `runDiscovery` (no `--enrich`/LLM gate, so `no_llm` and `llm_assisted` see
   the identical fix) — it (a) attaches `staticEvidence.crossFileFreedVia` so
   the judge can exonerate cross-file frees, and (b) synthesizes a new
   candidate at a sink parameter's signature line when a real heap allocation
   is passed in and never freed. A third, smaller bug surfaced while
   verifying (b) end-to-end: `analyzeLeakHeuristically` couldn't score
   `parameter_ownership` candidates at all (`findAllocVar` has nothing to
   find — the candidate has no local allocation call, it's a parameter), and
   `findEnclosingFunction`'s backward brace-walk breaks when anchored at a
   function's SIGNATURE line instead of a line inside its body, silently
   falling back to an arbitrary +20-line window that can bleed into the NEXT
   function. Both fixed the same way F3's pre-existing candidates needed
   fixing too — parsing the parameter name out of `allocation_site`
   (`file:line:parameter:<name>`) and advancing to the function's opening
   brace before the brace-walk. Full corpus re-verified after all three
   fixes — see "What's proven so far" above.
9. **`ScanDeps.evalStaticPathMap` was declared and parsed from config
   (`eval.staticPathMap`) but never wired into `ScanDeps` at any call site**
   (`headless.ts`, TUI `runner.ts`) — found while verifying bug #8 against
   the Dockerized static-analyzer (`./demo:/workspace/demo` mount, host
   paths ≠ container paths): `deps.evalStaticPathMap` was always `undefined`
   regardless of config, so every server-side-file static tool
   (`callGraph`, and the pre-existing `interproceduralFlow`/`scanBuildRun`)
   silently found nothing when the analyzer runs in Docker with a real path
   map configured — no error, just a quiet no-op degrade, since `analyzerPath()`
   falls back to the identity mapping. Root cause was genuinely subtle to
   isolate: a real repro attempt against Docker first hit a RED HERRING — a
   leftover local dev static-analyzer process (from working around this very
   gap) was still listening on `*:50061`, and `localhost` resolves to `::1`
   on this host, silently routing "localhost"-endpoint MCP calls to that
   stale host process (which can't see `/workspace/...` paths either) instead
   of the Docker container reachable via `127.0.0.1`. Fixed by threading
   `cfg.evalStaticPathMap` into the `deps` object at both `runScan` call sites.
   Verified end-to-end against the real Docker container with
   `eval.staticPathMap` configured to the compose mount — `char_calloc_22`
   scores identically to the identity-path verification. Documented in
   `docs/OPERATIONS.md` §4: the DEFAULT `determinism-gate.sh` run (Docker,
   no path map set) does NOT get the bug #8 benefit — `{tp:29,fp:7,fn:9,tn:81}`
   — vs `{tp:33,fp:4,fn:5,tn:84}` with `eval.staticPathMap` configured.
10. **Three more root causes in the SAME "ownership transfer" bug family as
    #8, found via 4 Explore/Plan agents investigating flow-variant 42-84
    (same day, later session)** — all fixed, all reusing the `correlateOwnership()`/
    `applyOwnershipCorrelations()` architecture #8 established rather than new
    systems:
    - **Return-value ownership FP** (flow-variant 42-45/61-68): a function that
      ALLOCATES and RETURNS a pointer (the opposite direction from #8's
      parameter case) was scored `confirmed_leak` even when its caller
      correctly freed the result — verified via a byte-for-byte transcript
      replay of `char_calloc_42`'s `goodB2GSource` (score 0.85). Root cause:
      `heuristic-judge.ts` additively sums 4 independently function-scoped
      static signals (`allocFreePairs`/`feasibleLeakPaths`/
      `ownershipConventions`/`earlyReturnCount`) with NO check against
      `analyzeLeakHeuristically`'s own (already-correct) interprocedural
      conclusion — unlike the parameter case, which has an explicit
      `freedViaCallee` short-circuit. Fixed with a mirror short-circuit gated
      on `patternType === INTERPROCEDURAL_LEAK && structuralLikelihood === 'low'`
      OR new project-wide `staticEvidence.freedViaCaller` evidence (from a new
      `CallGraphService.correlateReturnOwnership()`, symmetric to
      `correlateOwnership()`, reusing `FunctionInfo.assignedCalls` — confirmed
      via grep to have ZERO consumers anywhere before this fix).
    - **Return-value ownership FN**: the actual flaw site (a "dispatcher"
      function assigning a local from a call's return value and never freeing
      it, e.g. `data = badSource(data);`) never got a candidate at all — no
      direct allocation call, no pointer parameter. Fixed by synthesizing a
      candidate at the dispatcher's assignment line via the same
      `correlateReturnOwnership()` pass's `unfreedReturnOwnership` output.
    - **Multi-hop parameter chains** (flow-variant 51-54, up to 4 hops): the
      original #8 correlation only checked 1 hop, mis-attributing a
      pass-through function as the sink instead of walking to the real
      terminal sink — FN grew linearly with hop depth (16→50→84→118 across
      1-4 hops). Fixed with `walkOwnershipChain()`, a bounded (`MAX_HOPS=8`)
      recursive walk reusing the exact same `FreedCrossFileEntry`/
      `UnfreedSinkParamEntry` output shapes — depth-1 chains degrade to the
      original behavior exactly, so #8's cases are unaffected.
    - **STL container transport** (flow-variant 72-74, C++ `vector`/`list`/
      `map`): a heap allocation inserted into a container and extracted by the
      callee (`char *data = dataVector[2];`) was invisible to correlation
      entirely (100% FN — `extractCallArgs` only resolves bare-identifier
      arguments, and the container variable, not the original allocated
      variable, is what crosses the call boundary). Fixed with 2 new
      `FunctionInfo` fields (`containerCarriers`/`containerExtractions`) and a
      new `getCallReceiverNode()` AST helper (confirmed via live tree-sitter
      parse that `getCallFunctionNameNode` never captured the method-call
      receiver), correlated the same way but keyed on container identity.
    - Also fixed in passing: `pointerParams()`'s regex only matched `Type
      *name`, not C++ reference `Type &name` (variant 62) — narrow fix, not a
      full C++-reference `FunctionInfo` extraction (that remains a known gap,
      see below).
    - **Deliberately NOT fixed this round** (investigated, root-caused,
      explicitly deferred by user decision after seeing the cost/risk
      estimate): **virtual dispatch** (flow-variant 81-82) — root cause
      confirmed as `extractFunctionName()` dropping the class-qualifying
      prefix on out-of-class method definitions
      (`ClassName::method(...) {}`), causing every class's same-named override
      to collide on one `fnIndex` key; a correct fix needs 3 new extraction
      passes (class names, qualified naming, factory-binding resolution) with
      a narrow real-world payoff ceiling. **RAII constructor/destructor
      pairing** (flow-variant 83-84) — confirmed as a wholly different
      mechanism (alloc in ctor, free in dtor of the same class; FP≈TP on
      every clean case since "freed before this function returns" is
      structurally never true for a constructor). Both need their own
      follow-up plan.
    - Full corpus re-verified after all fixes — see "What's proven so far"
      above for the before/after numbers.

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
3. **Juliet `llm_assisted` full run** not yet done. A PRIOR attempt
   (`results/eval-llm_assisted-juliet-full/`, ~165/1658 cached across two
   pause points) was paused twice — first for bug #8 (parameter ownership),
   then again for bug #10 (return-value/multi-hop/container ownership) — that
   cache predates BOTH fixes and must NOT be resumed (it would just merge
   stale wrong verdicts with correct new ones); delete it and start a fresh
   run. Still expensive (1658 LLM calls), worth scoping with the user before
   launching.
3a. **Known, deliberately-deferred limitations** (all found + root-caused this
   session, none fixed): flow-variant 43-45/62-68 (C++ reference-parameter
   `Type &data` output/passing shapes — `pointerParams()` got a narrow regex
   fix for one lookup, but `FunctionInfo`'s parameter extraction doesn't
   recognize `&`-declared parameters as pointer-like at all, so neither
   `correlateOwnership()` nor `correlateReturnOwnership()` can track them);
   flow-variant 81-82 (virtual dispatch — `fnIndex` bare-name collision
   across classes' same-named overrides); flow-variant 83-84 (RAII
   constructor/destructor pairing — a different mechanism entirely, needs its
   own design). Also: the multi-hop fix (51-54) intentionally attributes a
   synthesized sink candidate to the chain's TERMINAL function only, which
   undercounts against Juliet's ground truth (it labels every hop, including
   pure pass-throughs, as a "flaw") — a real precision-vs-ground-truth-matching
   trade-off, not a bug; revisit only if thesis scoring needs literal
   per-hop matching.
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
