# Thesis Workspace

Root workspace for a Master's thesis on LLM-orchestrated memory leak
investigation for C/C++ repositories.

This repository is an umbrella workspace, not a single implementation repo. It
keeps the thesis components together at one top level.

> 📄 **Thesis documentation:** start at **[docs/THESIS.md](docs/THESIS.md)** (read-first
> overview) — full index at **[docs/README.md](docs/README.md)**.

## Components

### `apps/leak-inspector-tui` — Standalone scanner (Ink CLI/TUI) — THE orchestrator
- Headless/interactive agentic scanner; the single orchestration entrypoint.
  Native tool-calling via `packages/agent-core`.
- 4-stage HYBRID workflow: (A) static fan-out sub-agents gather evidence;
  (B) a dynamic worker builds + runs sanitizers, or follows a deterministic
  recipe (`buildTarget → lsanRun`, no LLM); (C) synthesize; (D) hybrid judge
  (heuristic for all bundles + LLM judge for borderline cases + optional
  consensus over k samples)
- Connects to the analyzers over MCP; writes report artifacts
  (JSON/Markdown/HTML/snapshot) to `results/<scanId>/`

### `apps/static-analyzer` — Static Analysis (NestJS)
- Serves MCP Streamable-HTTP (port 50061) to the TUI
- Tree-sitter AST, lexical scan, call graph, ownership analysis
- Clang Static Analyzer (`scan-build`), self-contained (the third-party
  LeakGuard submodule has been removed)
- gRPC server code still exists but currently has no consumer

### `apps/dynamic-analyzer` — Dynamic Analysis (NestJS)
- Serves MCP Streamable-HTTP (port 50062) to the TUI
- Valgrind Memcheck, AddressSanitizer, LeakSanitizer (Linux/Docker only)
- gRPC server code still exists but currently has no consumer

### `packages/agent-core` — Agentic loop (TS library)
- Framework-free native tool-calling loop, MCP client, multi-provider
  `callModel` (streaming, idle-timeout, context compaction)

### `packages/common` — Shared Types
- TypeScript types, DTOs, entities, Zod validation schemas
- Shared heuristic judge + leak analysis + report renderers
- Shared across all apps via `@mcpvul/common`

### `proto/` — gRPC service definitions
- Shared .proto files for inter-service communication
- `static-analyzer.proto` and `dynamic-analyzer.proto`

## System Flow

A single orchestration path: the TUI (`leak-inspector-tui`) drives `agent-core`'s
native tool-calling loop, which talks to the analyzers over MCP directly and
writes report artifacts to disk.

The HYBRID pipeline:
1. Static and dynamic analyzers expose MCP tools
2. The TUI orchestrator coordinates investigation across a target C/C++ repo
3. Findings are normalized into shared leak bundles
4. The system returns leak verdicts, explanations, and repair guidance

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for components/protocols/diagrams.

> The earlier web orchestration path (`control-plane` + `leak-inspector-ui` React
> SPA) has been removed from `master`; it is preserved on branch
> `web-implementation`.

## Demo Corpus

- `demo/memory_leak_corpus/` — test cases for evaluation
- Multiple cases: `simple_leak`, `complex_leak_lab`, `early_return_leak`, etc.
- Each case compilable with `make CC=clang`

## Quick Start

1. Start the analyzers (static + dynamic, MCP) via Docker Compose:

```bash
docker compose up --build
```

This brings up `static-analyzer` (MCP on port 50061) and `dynamic-analyzer`
(MCP on port 50062).

2. Configure the LLM key in `<root>/.env` or `apps/leak-inspector-tui/.env`, then
   run the TUI scanner:

```bash
cd apps/leak-inspector-tui
bun install
bun run dev
```

## Build All (Turbo)

```bash
bun run build
```

## Documentation

Start at **[docs/THESIS.md](docs/THESIS.md)**; full index at **[docs/README.md](docs/README.md)**.

- [docs/THESIS.md](docs/THESIS.md) — read-first thesis overview
- [docs/CONTRIBUTION.md](docs/CONTRIBUTION.md) — academic contribution + results
- [docs/RELATED-WORK.md](docs/RELATED-WORK.md) — baselines & related work (papers compared against)
- [docs/EVALUATION.md](docs/EVALUATION.md) — evaluation methodology + reproducibility
- [docs/BASELINE-COMPARISON.md](docs/BASELINE-COMPARISON.md) — runbook for running baseline comparisons
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — run/reproduce end-to-end
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, protocols, diagrams
- [docs/PROMPTS.md](docs/PROMPTS.md) — catalog of every LLM prompt + tool description
- [docs/sequence-diagrams.md](docs/sequence-diagrams.md) — runtime sequence flows
- [docs/GLOSSARY.md](docs/GLOSSARY.md) · [docs/DATASETS.md](docs/DATASETS.md) · [docs/SECURITY.md](docs/SECURITY.md) · [docs/GOAL.md](docs/GOAL.md)
