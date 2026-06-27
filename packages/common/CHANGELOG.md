# @cleak/common

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
