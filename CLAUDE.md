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
- Reads the LLM key from `<root>/.env` or `apps/leak-inspector-tui/.env`.

### apps/static-analyzer (Static Analysis — NestJS)
- NestJS service serving **MCP/HTTP on port 50061** to the TUI.
- Tree-sitter AST, lexical scan, call graph, ownership analysis, Clang Static
  Analyzer / `scan-build`.
- **MCP/HTTP is the only transport.** The old gRPC server (+ `proto/` + `@grpc/*`
  / `@nestjs/microservices`) had no consumer once the web path was removed and has
  been **deleted**; `main.ts` just builds a DI context and serves MCP.

### apps/dynamic-analyzer (Dynamic Analysis — NestJS)
- NestJS service serving **MCP/HTTP on port 50062** to the TUI.
- Valgrind Memcheck, AddressSanitizer, LeakSanitizer (Linux / Docker).

### packages/agent-core
- Framework-free native tool-calling loop, MCP client, multi-provider
  `callModel` (local / openai / anthropic / openai-compat), context compaction.

### packages/common (@cleak/common)
- Shared types, Zod schemas, the heuristic judge, consensus judge, leak analysis,
  and report renderers — TypeScript + Zod.

### Canonical docs (source of truth)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, protocols, the orchestration path
- [docs/PROMPTS.md](docs/PROMPTS.md) — every LLM prompt
- [docs/EVALUATION.md](docs/EVALUATION.md) — metrics, scoring model, reproducibility & baseline protocol
- [docs/SECURITY.md](docs/SECURITY.md) — trust model & controls for executing untrusted code
- [docs/DATASETS.md](docs/DATASETS.md) — obtaining/rebuilding Juliet + demo corpora (not committed)

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
│   └── agent-core/                 ← Framework-free native tool-calling loop + providers + MCP client
├── docs/                           ← Canonical docs (ARCHITECTURE, PROMPTS, EVALUATION, SECURITY, DATASETS)
├── docker-compose.yml              ← static-analyzer + dynamic-analyzer (MCP)
├── nest-cli.json                   ← NestJS monorepo configuration
├── package.json                    ← Root workspace config + turbo scripts
├── turbo.json                      ← Task pipeline (build/dev/lint/test)
├── tsconfig.base.json              ← Shared TypeScript config for NestJS apps
└── demo/memory_leak_corpus/        ← Test corpus (sources committed; binaries/results git-ignored)
```
(`tools/leak_guard_tool/`, `proto/`, and `results/` are gone / git-ignored — see the notes above.)

## Common Commands

### Analyzer Services (Docker Compose)
```bash
# Start the static + dynamic analyzers (MCP) via Docker Compose (from repo root)
docker compose up --build
```

### Build All (Turbo)
```bash
bun run build        # Builds all NestJS apps + the TUI via turbo pipeline
```

### Run the TUI / Analyzers
```bash
turbo run dev --filter=leak-inspector-tui     # run the agentic TUI scanner
turbo run dev --filter=static-analyzer        # static analyzer (MCP, port 50061)
turbo run dev --filter=dynamic-analyzer        # dynamic analyzer (MCP, port 50062)
```

## Environment Configuration

### LLM Key
- The LLM key is read from `<root>/.env` or `apps/leak-inspector-tui/.env`.

### Static Server
- `SCAN_BUILD_BIN`: Path to the `scan-build` binary (default `scan-build`)
- `RUNS_DIR`: Directory for scan-build run artifacts (default `./runs`)
- `MCP_HTTP_PORT`: MCP/HTTP port (default 50061)

### Dynamic Server
- `WORKSPACE_ROOT`: Root for allowed execution paths
- `RUNS_DIR`: Directory for storing run artifacts
- `VALGRIND_BIN`: Path to Valgrind binary

## Key MCP Tools

### Static Server Tools
- `repo.index_files`: Index repository files
- `memory.candidate_scan`: Lexical candidate discovery
- `memory.ast_scan`: AST-based structural analysis
- `memory.function_summary`: Function-level summaries
- `memory.call_graph`: Call graph extraction
- `memory.path_constraints`: Path constraint analysis
- `memory.interprocedural_flow`: Interprocedural dataflow
- `scanBuildRun`: Execute the project-level Clang Static Analyzer (scan-build)
- `scanBuildGetReport`: Retrieve scan-build findings

### Dynamic Server Tools
- `valgrind.analyze_memcheck`: Run Valgrind Memcheck
- `valgrind.get_report`: Retrieve normalized report
- `valgrind.list_findings`: Query findings with filters
- `valgrind.compare_runs`: Compare two analysis runs
- `asan.run`: Run AddressSanitizer-instrumented binary
- `lsan.run`: Run LeakSanitizer-instrumented binary
- `dynamic.run_binary`: Generic binary execution entrypoint
- `dynamic.list_runs`: List stored analysis runs

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
