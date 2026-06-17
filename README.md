# Thesis Workspace

Root workspace for a Master's thesis on LLM-orchestrated memory leak
investigation for C/C++ repositories.

This repository is an umbrella workspace, not a single implementation repo. It
keeps the thesis components together at one top level.

> 📄 **Thesis documentation:** start at **[docs/THESIS.md](docs/THESIS.md)** (read-first
> overview) — full index at **[docs/README.md](docs/README.md)**.

## Components

### `apps/control-plane` — Control Plane (NestJS)
- NestJS microservice, HTTP API gateway at port 8090
- Scan orchestration, judging, reporting, GitHub OAuth
- PostgreSQL persistence via TypeORM

### `apps/static-analyzer` — Static Analysis (NestJS)
- Serves gRPC (port 50051) and MCP Streamable-HTTP (port 50061)
- Tree-sitter AST, lexical scan, call graph, ownership analysis
- Clang Static Analyzer (`scan-build`), self-contained (the third-party
  LeakGuard submodule has been removed)

### `apps/dynamic-analyzer` — Dynamic Analysis (NestJS)
- Serves gRPC (port 50052) and MCP Streamable-HTTP (port 50062)
- Valgrind Memcheck, AddressSanitizer, LeakSanitizer (Linux/Docker only)

### `apps/leak-inspector-ui` — Frontend (React + Vite)
- React 19 + TypeScript SPA with Ant Design 5
- Zustand 5 state management, React Router 7 routing
- Real-time scan progress via SSE
- @xyflow/react workflow graph visualization

### `apps/leak-inspector-tui` — Standalone scanner (Ink CLI/TUI)
- Headless/interactive scanner driving the HYBRID pipeline directly
  (discovery → agentic investigation → judging → reporting)
- Connects to the analyzers over MCP; writes artifacts to `results/<scanId>/`

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

There are two orchestration paths sharing the same analyzers and schemas:
- **Web path** (`control-plane`): a JSON-action orchestrator drives the analyzers
  over gRPC/MCP, with PostgreSQL + a BullMQ queue and an SSE stream to the SPA.
- **CLI/TUI path** (`leak-inspector-tui`): `agent-core`'s native tool-calling loop
  drives the analyzers over MCP directly, writing report artifacts to disk.

Both run the HYBRID pipeline:
1. Static and dynamic analyzers expose gRPC and/or MCP tools
2. The orchestrator coordinates investigation across a target C/C++ repo
3. Findings are normalized into shared leak bundles
4. The system returns leak verdicts, explanations, and repair guidance

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for components/protocols/diagrams.

## Demo Corpus

- `demo/memory_leak_corpus/` — test cases for evaluation
- Multiple cases: `simple_leak`, `complex_leak_lab`, `early_return_leak`, etc.
- Each case compilable with `make CC=clang`

## Quick Start (Full Docker Stack)

```bash
docker compose up --build
```

Access the web UI at http://localhost:5173 (dev) or http://localhost:8090 (production).

## Frontend Dev

```bash
cd apps/leak-inspector-ui
bun install
bun run dev
```

## Backend Dev

```bash
cd apps/control-plane
bun install
bun run dev
```

## Build All (Turbo)

```bash
bun run build
```

## Runtime Preflight

Use this before end-to-end scans to verify that the local stack is actually reachable:

```bash
curl http://localhost:8090/api/runtime/preflight
```

For a local corpus smoke run without the UI:

```bash
bun run scan:smoke -- --case early_return_leak
```

The smoke runner checks PostgreSQL, the static analyzer, the dynamic analyzer,
and key toolchain binaries before attempting to boot the control plane.

## Documentation

Start at **[docs/THESIS.md](docs/THESIS.md)**; full index at **[docs/README.md](docs/README.md)**.

- [docs/THESIS.md](docs/THESIS.md) — read-first thesis overview
- [docs/CONTRIBUTION.md](docs/CONTRIBUTION.md) — academic contribution + results
- [docs/RELATED-WORK.md](docs/RELATED-WORK.md) — baselines & related work (papers compared against)
- [docs/EVALUATION.md](docs/EVALUATION.md) — evaluation methodology + reproducibility
- [docs/BASELINE-COMPARISON.md](docs/BASELINE-COMPARISON.md) — runbook for running baseline comparisons
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — run/reproduce end-to-end
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, protocols, diagrams, the two orchestration paths
- [docs/PROMPTS.md](docs/PROMPTS.md) — catalog of every LLM prompt + tool description
- [docs/sequence-diagrams.md](docs/sequence-diagrams.md) — runtime sequence flows
- [docs/GLOSSARY.md](docs/GLOSSARY.md) · [docs/DATASETS.md](docs/DATASETS.md) · [docs/SECURITY.md](docs/SECURITY.md) · [docs/GOAL.md](docs/GOAL.md)
