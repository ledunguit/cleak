# Datasets & Corpora

Benchmark archives, ingested corpora, compiled binaries, and scan outputs are
**not** committed (they bloat the repo and are fully regenerable). This document
is how to obtain/rebuild them. See `.gitignore` for the exact ignored paths and
`docs/EVALUATION.md` for how the corpora are scored.

Two hand-generated toy corpora (`demo/real_projects/` — 2 cJSON commit pairs;
`demo/memory_leak_corpus/` — ~12 lab cases) were removed: self-authored data isn't
credible evidence for thesis-level verification. The two evaluation corpora below
(Juliet, LAMeD) are the only ones cited for results. A single minimal fixture
(`apps/leak-inspector-tui/tests/fixtures/simple-leak/`) was kept outside `demo/`
for CI/dev smoke tests only — it is not, and should never be cited as, an
evaluation dataset.

## Juliet CWE-401 (memory leak)

1. Download the NIST Juliet C/C++ suite (public domain):
   <https://samate.nist.gov/SARD/downloads/test-suites/2017-10-01-juliet-test-suite-for-c-cplusplus-v1-3.zip>
   (save as `juliet.zip` at the repo root, or anywhere — it is git-ignored).
2. Unzip it somewhere, then ingest the CWE-401 cases into a v2 labeled corpus:
   ```bash
   unzip juliet.zip -d /tmp/juliet
   pnpm exec tsx scripts/juliet/ingest.ts --juliet /tmp/juliet --out demo/juliet_cwe401
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
pnpm exec tsx scripts/lamed/ingest.ts --manifest-only

# 2. Full materialize — clone each project at its bug commit into demo/lamed/cases/
pnpm exec tsx scripts/lamed/ingest.ts            # needs network + git; ~7 repos

# 3. Evaluate (positive-only → report RECALL + FP count, NOT specificity/MCC)
# --enrich is REQUIRED for a representative number: without it the heuristic judge
# gets no static evidence (functionSummary/pathConstraints) and recall collapses
# (verified 2026-08-06: 15.9% without --enrich vs 29.5% with it, same 41 cases,
# same commit — the old `STATIC_ENRICH=on` env var this replaced is no longer
# wired anywhere in the eval path, so it silently defaults off if omitted).
pnpm exec tsx scripts/evaluate-corpus.ts no_llm  --corpus demo/lamed --enrich
pnpm exec tsx scripts/evaluate-corpus.ts llm_assisted --corpus demo/lamed --consensus-n 3 --enrich
```

> **Real-project allocators — per-project profile (frozen for eval).** Real leaks flow
> through **factory allocators** (`cJSON_Duplicate`, `cJSON_CreateObject` → `cJSON_New_Item`)
> whose names carry no malloc/alloc token. Each LAMeD case in the manifest now carries
> `allocators`/`deallocators` (from `PROJECT_ALLOCATORS`/`PROJECT_DEALLOCATORS` in
> `scripts/lamed/ingest.ts`, ≈ LAMeD's **AllocSource/FreeSink**); the eval threads them via
> `extraAllocators`/`extraDeallocators` **end-to-end** (candidate-scan + c-parser + pairing +
> call-graph). This is the **frozen** profile that keeps eval deterministic.
> In **production** the LLM allocator-profiler (`domain/allocatorProfiler.ts`) discovers this
> API per-project (cache `<repo>/.cleak/`); its discovery accuracy is measured separately by
> `scripts/validate-allocator-profile.ts` (P/R/F1 vs the frozen list), so the LLM never injects
> non-determinism into the leak-eval. (The old `EXTRA_ALLOCATOR_NAMES` container env is kept only
> as an ad-hoc fallback.)
>
> Discovery + **path-sensitive judging** are now both wired: cjson `merge_patch` (a parameter
> freed on some paths, lost on an error path) is caught — recall **0 → 1/6 on cjson, FP 0** —
> via guard-subset reconciliation + parameter-ownership detection. Remaining
> cjson misses are deallocator-semantics (const-skip) + nested-loop control flow (see
> [CONTRIBUTION.md](CONTRIBUTION.md)).

> **Buildability — `build_command` per project (verified 2026-08).** Every case now carries
> a `build_command` (`PROJECT_BUILD_COMMANDS` in `scripts/lamed/ingest.ts`) — a CMake
> configure+build with optional external deps (OpenSSL/zlib/lzma/jpeg/...) switched OFF so
> the build succeeds offline, except **libssh2** which mandates one crypto backend (OpenSSL,
> via Homebrew). All 7 projects were **actually built** (`cmake --build`, not just configured)
> to confirm this — not assumed. This unlocks the deterministic `buildTarget → lsanRun`
> recipe and, more importantly, **Stage B2 targeted-harness synthesis** (`bear -- sh -c
> '<build_command>'` → `compile_commands.json` → `buildHarness`) — the mechanism a real
> leak *inside a library function* needs, since the base build alone rarely exercises it
> (unlike Juliet's self-contained `main()`). libtiff needs `tiff-tools=ON` specifically
> (unlike a minimal library build) because its LAMeD bug lives in `tools/tiffmedian.c`.
>
> **`validate-corpus.ts`'s per-file compile gate does NOT apply here — use `--skip-compile`.**
> Turning the gate on quarantined 38/41 cases, but every failure was the gate blindly
> `clang -fsyntax-only`-checking an UNRELATED file elsewhere in the tree (`docs/examples/
> cacertinmem.c`, `tools/bmp2tiff.c`, `examples/solv/checksig.c`, a Unity test fixture) that
> needs a build-generated header (`tif_config.h`, `pool.h`, `openssl/err.h`) the raw checkout
> doesn't have. That gate assumes Juliet-style flat, self-contained single-file cases; it is
> the wrong tool for a real multi-file autotools/CMake project and was never meant to replace
> an actual build. Trust the `cmake --build` audit above, not this gate, for LAMeD.

The ingest handles LAMeD's quirks: `target_function` overloads `;` as **both** a
parameter separator (inside the signature) and a multi-function separator, and
truncates mid-signature with ALL-CAPS return-type macros — so names are extracted
with a paren-depth-aware split + macro skip. 6 entries have an empty
`target_function` (file-level only → unscoreable in function mode; reported, not
dropped). Fairness: LAMeD has no clean labels, so compare on **recall + FP/KLOC**,
the same rule as the other positive-only baselines (see
[BASELINE-COMPARISON.md](BASELINE-COMPARISON.md)).

## Scan / eval outputs

Everything under any `results/` directory (events, snapshots, reports, metrics,
transcripts) is generated by a scan or an eval run and is git-ignored. Regenerate
with `leak-tui scan …`, `scripts/run-local-scan-smoke.ts`, or
`scripts/evaluate-corpus.ts` (see `docs/EVALUATION.md`).
