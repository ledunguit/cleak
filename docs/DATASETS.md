# Datasets & Corpora

Benchmark archives, ingested corpora, compiled binaries, and scan outputs are
**not** committed (they bloat the repo and are fully regenerable). This document
is how to obtain/rebuild them. See `.gitignore` for the exact ignored paths and
`docs/EVALUATION.md` for how the corpora are scored.

## Juliet CWE-401 (memory leak)

1. Download the NIST Juliet C/C++ suite (public domain):
   <https://samate.nist.gov/SARD/downloads/test-suites/2017-10-01-juliet-test-suite-for-c-cplusplus-v1-3.zip>
   (save as `juliet.zip` at the repo root, or anywhere — it is git-ignored).
2. Unzip it somewhere, then ingest the CWE-401 cases into a v2 labeled corpus:
   ```bash
   unzip juliet.zip -d /tmp/juliet
   bun scripts/juliet/ingest.ts --juliet /tmp/juliet --out demo/juliet_cwe401
   ```
   This materializes `demo/juliet_cwe401/` (git-ignored) with a `corpus_manifest.json`
   and a self-contained, buildable project per testcase. See `scripts/juliet/README.md`.

   **Statistics** (full CWE-401 ingest): **1984 cases**, 49 flow variants (`01`–`17`+),
   functional variants — `new` 672, `int` 360, `char`/`strdup`/`struct`/`twoIntsStruct`/`wchar`
   180 each, `malloc` 108, `destructor`/`virtual` 2. Build: `make CC=clang CXX=clang++`.
   Evals typically run a slice (`--limit 30`) for turnaround.

   **Labeling = function mode.** Ground truth comes from Juliet's naming: `<testcase>_bad`
   is the flaw; `goodG2B`/`goodB2G` are clean. The generated `Makefile` **drops `-DOMITGOOD`**
   and uses `-fsanitize=leak`, so the binary runs **both** the good and bad paths → good
   functions are genuinely `exercised_clean` (and LSan reports only the real leak).

## Real-project corpus (leak-fix commit oracle)

`demo/real_projects/` (git-ignored) is built from upstream **leak-fix commits**: the pre-fix
revision is the flaw (`actual:true`), the post-fix revision is clean (`actual:false`) — a
**line-mode** corpus (matched by `(file, line)`, not function name). Current: **4 cases** =
2 cJSON leak-fix pairs (`cjson-printbuffered`, `cjson-mergepatch`, each `-bad` + `-fixed`).

```bash
bun scripts/real-projects/ingest.ts \
  --ground-truth demo/real_projects/ground-truth.json --out demo/real_projects
```
`ground-truth.json` (the oracle: project repo + fixCommit + file/function/flawLine/fixedLine)
**is committed**; clones + materialized cases are git-ignored. See [EVALUATION.md](EVALUATION.md)
§2 for function-mode vs line-mode scoring.

## LAMeD benchmark (peer-reviewed external baseline)

LAMeD (EASE 2025) is the only peer-reviewed C/C++ leak benchmark. Its released
artifact (Zenodo **10.5281/zenodo.15089703**, BSD-3) ships `memleak_benchmark.json`
— **41 developer-confirmed leaks** across 7 C projects (curl, libtiff, cjson,
libsolv, libxml2, libssh2, rabbitmq-c), **positive-only and function-level** (no
line numbers, no negative labels). The source JSON + the cJSON annotation CSV are
**committed** under `demo/lamed/`; the v2 manifest + cloned/materialized sources
are git-ignored (regenerable).

```bash
# 1. Manifest only (fast, no network) — inspect the 41-case → 43-flaw mapping
bun scripts/lamed/ingest.ts --manifest-only

# 2. Full materialize — clone each project at its bug commit into demo/lamed/cases/
bun scripts/lamed/ingest.ts            # needs network + git; ~7 repos

# 3. Evaluate (positive-only → report RECALL + FP count, NOT specificity/MCC)
bun scripts/evaluate-corpus.ts no_llm  --corpus demo/lamed
bun scripts/evaluate-corpus.ts llm_assisted --corpus demo/lamed --consensus-n 3
```

> **Real-project allocators (`EXTRA_ALLOCATOR_NAMES`).** Running on cjson showed the
> leaks flow through **factory allocators** (`cJSON_Duplicate`, `cJSON_CreateObject`
> → `cJSON_New_Item`) whose names carry no malloc/alloc token, so candidate-scan
> never discovers the alloc site → **0% recall for both heuristic and LLM**. Supply
> the project's allocator API (≈ LAMeD's AllocSource annotations) as a
> comma-separated env on the **static-analyzer container**, then rebuild/recreate:
> ```bash
> EXTRA_ALLOCATOR_NAMES="cJSON_Duplicate,cJSON_CreateObject,cJSON_CreateArray,cJSON_CreateString,cJSON_New_Item" \
>   docker compose up -d --force-recreate static-analyzer
> ```
> This makes the factory-alloc leak sites discoverable (candidates ↑); judging them
> still needs interprocedural/path-sensitive reasoning (the open work — see
> [CONTRIBUTION.md](CONTRIBUTION.md) threats-to-validity).

The ingest handles LAMeD's quirks: `target_function` overloads `;` as **both** a
parameter separator (inside the signature) and a multi-function separator, and
truncates mid-signature with ALL-CAPS return-type macros — so names are extracted
with a paren-depth-aware split + macro skip. 6 entries have an empty
`target_function` (file-level only → unscoreable in function mode; reported, not
dropped). Fairness: LAMeD has no clean labels, so compare on **recall + FP/KLOC**,
the same rule as the other positive-only baselines (see
[BASELINE-COMPARISON.md](BASELINE-COMPARISON.md)).

## Demo memory-leak corpus (legacy, hand-labeled)

`demo/memory_leak_corpus/` holds the hand-labeled cases (sources + per-case
`Makefile`/build instructions are committed; compiled binaries and `results/` are
not). Rebuild a case's binary from source:

```bash
cd demo/memory_leak_corpus/<case>
make            # or the build command in the case's manifest entry
```

## Scan / eval outputs

Everything under any `results/` directory (events, snapshots, reports, metrics,
transcripts) is generated by a scan or an eval run and is git-ignored. Regenerate
with `leak-tui scan …`, `scripts/run-local-scan-smoke.ts`, or
`scripts/evaluate-corpus.ts` (see `docs/EVALUATION.md`).
