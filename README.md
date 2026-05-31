# Thesis Workspace

Root workspace for a Master's thesis on LLM-orchestrated memory leak
investigation for C/C++ repositories.

This repository is an umbrella workspace, not a single implementation repo. It
keeps the thesis components together at one top level.

## Components

### `apps/control-plane` — Control Plane (NestJS)
- NestJS microservice, HTTP API gateway at port 8090
- Scan orchestration, judging, reporting, GitHub OAuth
- PostgreSQL persistence via TypeORM

### `apps/static-analyzer` — Static Analysis (NestJS/gRPC)
- gRPC service at port 50051
- Tree-sitter AST, lexical scan, call graph, LeakGuard adapter

### `apps/dynamic-analyzer` — Dynamic Analysis (NestJS/gRPC)
- gRPC service at port 50052
- Valgrind Memcheck, AddressSanitizer, LeakSanitizer

### `apps/leak-inspector-ui` — Frontend (React + Vite)
- React 19 + TypeScript SPA with Ant Design 5
- Zustand 5 state management, React Router 7 routing
- Real-time scan progress via SSE
- @xyflow/react workflow graph visualization

### `packages/common` — Shared Types
- TypeScript types, DTOs, entities, Zod validation schemas
- Shared across all NestJS apps via `@mcpvul/common`

### `tools/leak_guard_tool` — Clang Static Analyzer (submodule)
- Third-party leak detection tool
- Integrated via static-analyzer's LeakGuardAdapter
- Runs in `leakguard-runtime` Docker container

### `proto/` — gRPC service definitions
- Shared .proto files for inter-service communication
- `static-analyzer.proto` and `dynamic-analyzer.proto`

## System Flow

1. Static and dynamic analyzers expose gRPC services
2. Control plane coordinates investigation across a target C/C++ repo
3. Findings are normalized into shared leak bundles
4. The system returns leak verdicts, explanations, and repair guidance

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

## Architecture Docs

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed system architecture.
See [THESIS_WORKSPACE_OVERVIEW.md](THESIS_WORKSPACE_OVERVIEW.md) for workspace overview.
