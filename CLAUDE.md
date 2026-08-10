# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Master's thesis workspace on LLM-orchestrated memory leak investigation for C/C++ repositories. The system is a single agentic CLI/TUI scanner (`leak-inspector-tui`) that orchestrates static and dynamic analysis exposed as MCP (Model Context Protocol) servers, using native tool-calling.

> **Note:** an earlier web implementation (NestJS control-plane + React SPA) has
> been removed from `master`. It is preserved on the git branch
> `web-implementation`. `master` is now **TUI-only**.

## Architecture

> **Current source of truth:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
> (components, protocols, diagrams) and [docs/PROMPTS.md](docs/PROMPTS.md) (every
> LLM prompt). Key points:
> - The orchestrator is **`apps/leak-inspector-tui`** (standalone HYBRID scanner
>   that drives the analyzers over MCP directly), built on
>   **`packages/agent-core`** (framework-free native tool-calling loop: MCP
>   client, multi-provider streaming `callModel`, idle-timeout, context
>   compaction).
> - The analyzers live under `apps/static-analyzer` and `apps/dynamic-analyzer`,
>   each serving **MCP/HTTP** to the TUI. The scan-build slot is now a
>   self-contained **Clang Static Analyzer (`scan-build`)** — the third-party
>   `tools/leak_guard_tool` submodule has been removed.
> - There is **one orchestration path**: the CLI/TUI path (`leak-inspector-tui`,
>   agent-core native tool-calling). See docs/ARCHITECTURE.md §1.

The workspace consists of these main components:

### apps/leak-inspector-tui (Orchestrator — Ink CLI/TUI)
- Standalone agentic CLI/TUI scanner; **the** orchestrator.
- Native tool-calling via `packages/agent-core`.
- 4-stage HYBRID workflow:
  - **(A)** static fan-out sub-agents gather evidence;
  - **(B)** dynamic worker builds + runs sanitizers OR a deterministic recipe
    (`buildTarget` → `lsanRun`, no LLM);
  - **(C)** synthesize;
  - **(D)** hybrid judge = heuristic for ALL bundles + LLM judge for BORDERLINE
    + optional consensus (k samples).
- Writes report artifacts (JSON / Markdown / HTML / snapshot) to
  `results/<scanId>/` on disk.
- Reads config from `~/.config/cleak/config.json` (CLI flag > config file > default).

### apps/static-analyzer (Static Analysis — NestJS)
- NestJS service serving **MCP/HTTP on port 50061** to the TUI.
- Tree-sitter AST, lexical scan, call graph, ownership analysis, Clang Static
  Analyzer / `scan-build`. All analysis routes through `CParserService` (tree-sitter
  C/C++ parser with a 512-entry SHA1-content LRU cache).
- **MCP/HTTP is the only transport.** The old gRPC server (+ `proto/` + `@grpc/*`
  / `@nestjs/microservices`) had no consumer once the web path was removed and has
  been **deleted**; `main.ts` just builds a DI context and serves MCP.

### apps/dynamic-analyzer (Dynamic Analysis — NestJS)
- NestJS service serving **MCP/HTTP on port 50062** to the TUI.
- Valgrind Memcheck, AddressSanitizer, LeakSanitizer (Linux / Docker).

### packages/agent-core
- Framework-free native tool-calling loop, MCP client, multi-provider
  `callModel` (local / openai / anthropic / openai-compat), context compaction.

### packages/config (@cleak/config)
- Centralized config management — Zod schema, JSON loader/persister at
  `~/.config/cleak/config.json`, CLI helpers (`config init/get/set/unset`),
  provider settings conversion. Used by the TUI and common packages.

### packages/common (@cleak/common)
- Shared types, Zod schemas, the heuristic judge, consensus judge, leak analysis,
  and report renderers — TypeScript + Zod.

### Canonical docs (source of truth)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, protocols, the orchestration path
- [docs/PROMPTS.md](docs/PROMPTS.md) — every LLM prompt
- [docs/EVALUATION.md](docs/EVALUATION.md) — metrics, scoring model, reproducibility & baseline protocol
- [docs/SECURITY.md](docs/SECURITY.md) — trust model & controls for executing untrusted code
- [docs/DATASETS.md](docs/DATASETS.md) — obtaining/rebuilding Juliet + demo corpora (not committed)
- Additional: [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md) (detailed tool reference),
  [docs/GLOSSARY.md](docs/GLOSSARY.md), [docs/OPERATIONS.md](docs/OPERATIONS.md),
  [docs/SYSTEM-DIAGRAM.md](docs/SYSTEM-DIAGRAM.md),
  [docs/sequence-diagrams.md](docs/sequence-diagrams.md), and thesis artifacts
  ([docs/THESIS.md](docs/THESIS.md) et al. in Vietnamese).

### MCP tool surface (no proto/)
- Tool I/O is declared with **Zod `inputSchema`** inside each analyzer's MCP server
  (`apps/static-analyzer/src/mcp/static-mcp-server.ts`,
  `apps/dynamic-analyzer/src/mcp/dynamic-mcp-server.ts`).
- The former `proto/` gRPC service definitions have been **removed** (gRPC had no
  consumer once the project went TUI-only).

## Communication Flow

1. The TUI orchestrator (`leak-inspector-tui`) drives the investigation via
   native tool-calling.
2. Static and dynamic analyzers expose MCP tools over HTTP; the TUI calls them.
3. Findings are normalized into shared leak bundles (from `@cleak/common`)
4. Judge layer produces verdicts, explanations, and repair suggestions
5. Reports are emitted in multiple formats for evaluation

## Project Structure

```
Thesis/
├── apps/                           ← Turborepo applications
│   ├── static-analyzer/            ← Static analysis MCP service (port 50061)
│   ├── dynamic-analyzer/           ← Dynamic analysis MCP service (port 50062)
│   └── leak-inspector-tui/         ← Standalone agentic TUI/CLI scanner (HYBRID, MCP) — the orchestrator
├── packages/
│   ├── common/                     ← Shared types, DTOs, entities, Zod schemas, analysis (@cleak/common)
│   ├── config/                     ← Config schema, loader, persist, CLI helpers (@cleak/config)
│   └── agent-core/                 ← Framework-free native tool-calling loop + providers + MCP client
├── docs/                           ← Canonical docs (ARCHITECTURE, PROMPTS, EVALUATION, SECURITY, DATASETS)
├── docker-compose.yml              ← static-analyzer + dynamic-analyzer (MCP)
├── nest-cli.json                   ← NestJS monorepo configuration
├── package.json                    ← Root workspace config + turbo scripts
├── turbo.json                      ← Task pipeline (build/dev/lint/test)
├── tsconfig.base.json              ← Shared TypeScript config for NestJS apps
├── demo/                            ← Eval corpora (git-ignored, rebuilt via docs/DATASETS.md): Juliet CWE-401, LAMeD
└── scripts/                        ← 21 eval/test scripts, 2 shell scripts, 5 data subdirs
```
(`tools/leak_guard_tool/`, `proto/`, `mcp-dynamic-analysis-server/`, `mcp-memory-common/`, `mcp-memory-static-analysis-server/`, and `results/` are gone / git-ignored — see the notes above. `.gitmodules` retains stale entries for the three old MCP submodules. `demo/real_projects/` and `demo/memory_leak_corpus/` — hand-generated toy corpora, not credible for evaluation — were removed; the smoke-test fixture that lived at `demo/memory_leak_corpus/simple_leak` moved to `apps/leak-inspector-tui/tests/fixtures/simple-leak/` since it's dev/CI plumbing, not an evaluation dataset.)

## Common Commands

### Analyzer Services (Docker Compose)
```bash
# Start the static + dynamic analyzers (MCP) via Docker Compose (from repo root)
docker compose up --build
```

### Build All (Turbo)
```bash
pnpm run build        # Builds all NestJS apps + the TUI via turbo pipeline
pnpm run typecheck    # Type-check all packages (separate turbo task)

# Package manager: pnpm@11.18.0 (per root package.json), runtime: Node 22 (no Bun)
# Global install:  pnpm run cleak:install (builds @cleak/cli then npm i -g)
```

### Development / Test Scripts
```bash
pnpm run scan:smoke        # tsx scripts/run-local-scan-smoke.ts
pnpm run eval:corpus       # tsx scripts/evaluate-corpus.ts
pnpm run eval:compare      # tsx scripts/compare-modes.ts
pnpm run mcp:contract      # tsx scripts/mcp-contract-test.ts
```

Development scripts live in `scripts/` — 21 TypeScript evaluation/test files,
2 shell scripts (`consensus-ablation.sh`, `determinism-gate.sh`), and 5 data
subdirectories (`corpus/`, `juliet/`, `lamed/`, `real-projects/`, `tests/`).

### Run the TUI / Analyzers
```bash
turbo run dev --filter=leak-inspector-tui     # run the agentic TUI scanner
turbo run dev --filter=static-analyzer        # static analyzer (MCP, port 50061)
turbo run dev --filter=dynamic-analyzer        # dynamic analyzer (MCP, port 50062)

# Or run the TUI directly:
pnpm exec tsx src/cli.ts tui                    # default: interactive TUI
pnpm exec tsx src/cli.ts scan --repo <path>     # headless scan
pnpm exec tsx src/cli.ts eval --corpus <path>   # corpus evaluation
pnpm exec tsx src/cli.ts tools                  # MCP connectivity check
```

## Configuration

All TUI/CLI configuration is persisted in a single JSON file at `~/.config/cleak/config.json`. Precedence: **CLI flag > config file > built-in default**. The TUI/CLI does not use `.env` files; the analyzer Docker services use `.env` (with `.env.example` templates checked in) for environment-specific overrides.

- `cleak config init` — write a fully-keyed template
- `cleak config get` — print the resolved (effective) config
- `cleak config set <key> <value>` — update one key
- `/config` in the TUI — interactive settings screen

### Static Server (Docker)
- `SCAN_BUILD_BIN`: Path to the `scan-build` binary (default `scan-build`)
- `RUNS_DIR`: Directory for scan-build run artifacts (default `./runs`)
- `MCP_HTTP_PORT`: MCP/HTTP port (default 50061)

### Dynamic Server (Docker)
- `WORKSPACE_ROOT`: Root for allowed execution paths
- `RUNS_DIR`: Directory for storing run artifacts
- `VALGRIND_BIN`: Path to Valgrind binary

## Key MCP Tools

> Full reference (input schema, return type, handler, JSON-RPC examples):
> [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md)

### Static Server Tools (11 tools — port 50061)
- `indexFiles`: *Index all C/C++ source files recursively from a root path*
- `candidateScan`: *Scan a file for allocation sites (malloc, calloc, realloc, strdup, new). Optionally supply per-project factory allocators / custom deallocators (≈ LAMeD AllocSource/FreeSink) so wrapper-named allocators (e.g. cJSON_Duplicate) become candidates.*
- `astScan`: *AST-based structural analysis for memory leak patterns*
- `callGraph`: *Extract call graph edges and nodes. Optionally supply per-project allocators/deallocators so the alloc→free reachability chains track factory allocators.*
- `functionSummary`: *Summarize a function: alloc/free balance, local vars, calls. Optionally supply per-project allocators/deallocators so factory-allocated vars are paired.*
- `interproceduralFlow`: *Interprocedural alloc/free flow tracing for a function. Optionally supply per-project allocators/deallocators so the trace tracks factory allocators (cJSON_malloc/_TIFFfree/…) — without them it is blind to non-libc memory APIs.*
- `pathConstraints`: *Analyze path constraints and feasible paths around an allocation. Optionally supply per-project allocators/deallocators so factory allocations are tracked on exit paths.*
- `ownershipSummary`: *Summarize ownership conventions across files*
- `ownershipConventions`: *Detect ownership-transfer conventions in a file*
- `scanBuildRun`: *Run the project-level Clang Static Analyzer (scan-build) over the project build*
- `scanBuildGetReport`: *Retrieve Clang Static Analyzer (scan-build) findings*

> 5 content-capable tools exposed to the LLM sub-agent in Stage A: `candidateScan`,
> `astScan`, `functionSummary`, `pathConstraints`, `ownershipConventions`.
> The other 6 require a shared filesystem and are driven by the orchestrator.

### Dynamic Server Tools (11 tools — port 50062)
- `buildTarget`: *Build the project with sanitizer-instrumented compiler flags*
- `valgrindMemcheck`: *Run Valgrind Memcheck for detailed leak analysis*
- `valgrindGetReport`: *Retrieve a normalized Valgrind report*
- `valgrindListFindings`: *Query Valgrind findings with optional filters*
- `valgrindCompareRuns`: *Compare two Valgrind analysis runs*
- `asanRun`: *Run the binary under AddressSanitizer for leak detection*
- `lsanRun`: *Run the binary under LeakSanitizer*
- `runBinary`: *Run a binary without instrumentation*
- `buildHarness`: *Compile+link a targeted per-candidate harness (Stage B2) against the real project's own compiler flags (recovered via compile_commands.json), instead of building the whole project*
- `libfuzzerRun`: *Run a buildHarness(entryStyle="fuzzer") binary for a short bounded time budget — the fuzz-tier escalation when a targeted single-shot run came back clean*
- `listRuns`: *List stored dynamic analysis runs*

> Most dynamic tools are driven by the deterministic Stage B recipe, not by the LLM.
> Stage B2 (opt-in, `workflow.targetedHarness.enabled`, off by default) is the
> exception: an LLM harness worker calls `buildHarness`/`lsanRun`/`asanRun` directly
> for candidates static evidence alone left borderline; the fuzz-tier escalation that
> may follow is deterministic orchestrator code, not a further LLM turn.

## Important Notes

### scan-build (deep-static slot)
- The static server runs Clang `scan-build` DIRECTLY in its own container (clang +
  clang-tools baked into the image) — no nested `docker run`, no `docker.sock` mount.
- scan-build intercepts the project's own build (`buildCommand`) and parses the
  emitted Clang diagnostics into structured findings.

### Valgrind Platform Limitations
- Valgrind is Linux-only and will not work natively on macOS
- Always use Docker for dynamic analysis on macOS

### Workspace Security
- Dynamic server validates all executable paths within `WORKSPACE_ROOT`
- Artifacts are isolated per run ID to prevent cross-contamination

### Report Formats
The system produces four output formats:
- **JSON**: Machine-readable structured findings
- **Markdown**: Human-readable text report
- **HTML**: Styled web-viewable report
- **Snapshot**: Experiment comparison format with metadata
