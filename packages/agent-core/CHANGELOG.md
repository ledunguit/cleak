# @cleak/agent-core

## 0.2.2

### Patch Changes

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

- Initial public release: a framework-free native tool-calling agentic loop with an MCP
  client and multi-provider streaming `callModel` (OpenAI / Anthropic / local), plus
  idle-timeout handling and context compaction.
