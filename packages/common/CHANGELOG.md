# @cleak/common

## 0.4.0

### Minor Changes

- feat(harness): evaluation harness improvements
  - Extract `countSourceLoc` and `listSourceFiles` to shared `@cleak/common/analysis/harness-utils` (DRY)
  - Refactor `runEval` into 7 modular phases (loadManifest, gateCorpus, captureRunProvenance, prepareCaseCache, scoreCases, aggregateResults)
  - Add stratify, cache/resume, and per-variant breakdowns (byFlowVariant, byFunctionalVariant, byCwe) to baseline eval
  - Add calibration, confidence intervals, and provenance to baseline results
  - Add `--stratify`, `--dry-run`, `--resume`, `--concurrency`, and all ablation flags to `evaluate-corpus.ts`
  - Add `--help` and persist baseline comparison results to files
  - Expand LaTeX output to functional-variant, CWE, and calibration tables
  - Add `generatedAtMs` to EvalResult for CI/ML tracking
  - Add runtime Zod validation for EvalOptions
  - Comprehensive test coverage: 71 new tests across 5 test files

## 0.3.0

### Minor Changes

- Refactor monorepo: split types into domain modules, add new subpath exports (constants/allocators, mcp/\*), extract reporting modules, fix TypeScript type safety in dynamic evidence capture, rewrite README with humanizer patterns.

  @cleak/common: New subpath exports (`./constants/allocators`, `./mcp/*`), types restructured from monolithic `leak-schema.types.ts` into 8 domain modules, reporting module split into per-format renderers, new peer dependencies (express, @modelcontextprotocol/sdk).
  @cleak/cli: Fix TypeScript TS2339 errors in dynamic evidence capture, rewrite README.md.
  @cleak/agent-core: Sync release (no public API changes).

## 0.2.1

### Patch Changes

- Add package READMEs (developer guides: public API surface, modules, and the leak
  verdict model). Docs-only — no runtime change. Publishes a README onto the npm
  package pages, which were previously README-less.

## 0.2.0

### Minor Changes

- Path-sensitive static engine + a working HYBRID dynamic stage.
  - **Static engine (C/C++):** C++ support via `tree-sitter-cpp` with `new`/`delete`
    leak detection; switch/case guards in the CFG path analysis; dead-code
    reachability + path-sensitive/AST CFG hygiene (drops the old ±3-line and
    regex-on-AST heuristics).
  - **Dynamic analysis:** the HYBRID dynamic stage now actually produces correlated
    leak evidence (sanitizer runs no longer aborted by the address-space `ulimit`;
    `llvm-symbolizer` wired for file:line; a real LeakSanitizer leak parser). A new
    **deterministic** dynamic stage (build → LSan, no LLM) runs under `no_llm` when
    invoked with `--dynamic ≠ off` and a build command, enabling a clean
    LLM-orchestration × dynamic-evidence ablation.
  - **Judge:** consensus (k-sample) judge and richer evidence (ownership summaries,
    alloc→free pairs, feasible leak paths, static↔dynamic correlation).

## 0.1.0

### Minor Changes

- Initial public release: shared types, Zod schemas, and framework-free C/C++ memory-leak
  analysis — the heuristic judge, consensus judge, leak analysis, and report renderers.
