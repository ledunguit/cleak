# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Master's thesis workspace on LLM-orchestrated memory leak investigation for C/C++ repositories. The system uses a microservices architecture with MCP (Model Context Protocol) servers for static and dynamic analysis, coordinated by a central NestJS control plane.

## Architecture

> **Current source of truth:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
> (components, protocols, diagrams) and [docs/PROMPTS.md](docs/PROMPTS.md) (every
> LLM prompt). Two updates since this section was first written:
> - New components: **`packages/agent-core`** (framework-free native tool-calling
>   loop: MCP client, multi-provider streaming `callModel`, idle-timeout, context
>   compaction) and **`apps/leak-inspector-tui`** (standalone HYBRID scanner that
>   drives the analyzers over MCP directly).
> - The analyzers now live under `apps/static-analyzer` and `apps/dynamic-analyzer`
>   (not `mcp-memory-*`), each serving **both** gRPC and MCP. The leakguard slot
>   is now a self-contained **Clang Static Analyzer (`scan-build`)** — the
>   third-party `tools/leak_guard_tool` submodule has been removed.
> - There are **two orchestration paths**: the web path (`control-plane`, a
>   JSON-action orchestrator) and the CLI/TUI path (`leak-inspector-tui`,
>   agent-core native tool-calling). See docs/ARCHITECTURE.md §1.

The workspace consists of six main components:

### apps/control-plane (Control Plane — NestJS)
- NestJS microservice; HTTP API gateway at port 8090
- Three services: control-plane, static-analyzer, dynamic-analyzer
- PostgreSQL for persistent storage
- GitHub OAuth integration for repository management
- gRPC inter-service communication via proto/ definitions
- Orchestrates memory leak investigation pipeline

### apps/leak-inspector-ui (Frontend)
- React 19 + TypeScript SPA built with Vite
- Ant Design 5 component library with custom theming
- Zustand 5 for state management
- React Router 7 for client-side routing
- @xyflow/react v11 for workflow graph visualization
- Real-time scan progress via Server-Sent Events (SSE)
- Docker multi-stage build (nginx:alpine serves static files, proxies /api/ to control-plane:8090)

### mcp-memory-static-analysis-server
- Static analysis MCP server exposing memory-leak-oriented tools
- Provides repository indexing, candidate scanning, AST analysis, call graphs
- Integrates LeakGuard analyzer via Docker
- Supports both stdio and HTTP transports
- Requires Docker access for LeakGuard execution

### mcp-dynamic-analysis-server
- Dynamic analysis MCP server for runtime evidence collection
- Wraps Valgrind Memcheck, AddressSanitizer, and LeakSanitizer
- Normalizes findings into shared leak bundle format
- Stores run artifacts under `runs/` directory
- Linux-only (use Docker on macOS)

### mcp-memory-common
- Shared Pydantic models for memory leak schemas
- Ensures consistent data exchange between all components

### tools/leak_guard_tool
- Existing memory leak analyzer codebase (third-party submodule)
- Integrated via static server's LeakGuard adapter
- Runs in `leakguard-runtime` Docker container

### proto/
- Shared gRPC service definitions
- `static-analyzer.proto` and `dynamic-analyzer.proto`
- Used by all three NestJS apps for inter-service communication

## Communication Flow

1. Static and dynamic analyzers expose MCP tools over HTTP
2. NestJS control plane coordinates investigation by calling these tools
3. Findings are normalized into shared leak bundles (from mcp-memory-common)
4. Judge layer produces verdicts, explanations, and repair suggestions
5. Reports are emitted in multiple formats for evaluation

## Project Structure

```
Thesis/
├── apps/                           ← Turborepo applications
│   ├── control-plane/              ← API gateway + orchestrator (port 8090)
│   ├── static-analyzer/            ← Static analysis gRPC service (port 50051)
│   ├── dynamic-analyzer/           ← Dynamic analysis gRPC service (port 50052)
│   └── leak-inspector-ui/          ← React SPA frontend
├── packages/
│   └── common/                     ← Shared types, DTOs, entities, Zod schemas (@mcpvul/common)
├── tools/
│   └── leak_guard_tool/            ← Third-party Clang Static Analyzer (submodule)
├── proto/                          ← Shared gRPC service definitions
├── docker-compose.yml              ← Full stack deployment (6 services)
├── nest-cli.json                   ← NestJS monorepo configuration
├── package.json                    ← Root workspace config + turbo scripts
├── turbo.json                      ← Task pipeline (build/dev/lint/test)
├── tsconfig.base.json              ← Shared TypeScript config for NestJS apps
├── demo/memory_leak_corpus/        ← Test corpus
└── results/                        ← Scan outputs
```

## Common Commands

### Full System Demo
```bash
# Start all services via Docker Compose (from repo root)
docker compose up --build

# Access web UI at http://localhost:5173 (frontend) or http://localhost:8090 (API)
```

### Frontend Development (Hot Reload)
```bash
cd apps/leak-inspector-ui
bun install
bun run dev          # Vite dev server at http://localhost:5173
bun run build        # TypeScript check + production build
```

### Backend Development
```bash
cd apps/control-plane
bun install
bun run dev          # NestJS watch mode
```

### Build All (Turbo)
```bash
bun run build        # Builds all NestJS apps + frontend via turbo pipeline
```

### Run Individual App
```bash
bun run dev:control-plane     # or turbo run dev --filter=control-plane
turbo run dev --filter=leak-inspector-ui
nest build control-plane      # from repo root (uses nest-cli.json)
```

## Environment Configuration

### Control Plane
- `PORT`: Control plane port (default: 8090)
- `POSTGRES_HOST/DB/USER/PASSWORD`: PostgreSQL connection
- `STATIC_ANALYZER_URL` / `DYNAMIC_ANALYZER_URL`: gRPC endpoints
- `GITHUB_CLIENT_ID/SECRET/REDIRECT_URI`: GitHub OAuth
- `GITHUB_CLONE_ROOT`: Repository clone directory
- `FRONTEND_URL`: CORS origin for frontend

### Static Server
- `LEAKGUARD_REPO_ROOT`: Path to leak_guard_tool
- `LEAKGUARD_DOCKER_IMAGE`: leakguard-tool:dev
- `LEAKGUARD_DOCKER_PLATFORM`: linux/amd64

### Dynamic Server
- `WORKSPACE_ROOT`: Root for allowed execution paths
- `RUNS_DIR`: Directory for storing run artifacts
- `VALGRIND_BIN`: Path to Valgrind binary

### Frontend (apps/leak-inspector-ui)
- Vite proxy: /api/ → http://localhost:8090 (dev only)
- Production: nginx reverse proxy /api/ → http://control-plane:8090

## Key MCP Tools

### Static Server Tools
- `repo.index_files`: Index repository files
- `memory.candidate_scan`: Lexical candidate discovery
- `memory.ast_scan`: AST-based structural analysis
- `memory.function_summary`: Function-level summaries
- `memory.call_graph`: Call graph extraction
- `memory.path_constraints`: Path constraint analysis
- `memory.interprocedural_flow`: Interprocedural dataflow
- `memory.leakguard_run`: Execute LeakGuard analyzer
- `memory.leakguard_get_report`: Retrieve LeakGuard findings

### Dynamic Server Tools
- `valgrind.analyze_memcheck`: Run Valgrind Memcheck
- `valgrind.get_report`: Retrieve normalized report
- `valgrind.list_findings`: Query findings with filters
- `valgrind.compare_runs`: Compare two analysis runs
- `asan.run`: Run AddressSanitizer-instrumented binary
- `lsan.run`: Run LeakSanitizer-instrumented binary
- `dynamic.run_binary`: Generic binary execution entrypoint
- `dynamic.list_runs`: List stored analysis runs

## Frontend Architecture

### Pages & Routes

| Page | Route | Description |
|---|---|---|
| SetupPage | `/` | Repository selection, scan options, workspace management |
| ActivityPage | `/scan/:id` | Real-time phase timeline + workflow DAG + terminal logs |
| ReportPage | `/scan/:id/report` | Verdict table, evidence cards, diff viewer |
| InvestigationsPage | `/investigations` | Scan history management |
| LogsPage | `/logs` | Live SSE server-side log stream |

### Key Dependencies
- **React 19** with TypeScript strict mode
- **Vite 7** with React plugin, path alias `@/` → `src/`
- **Ant Design 5** (ConfigProvider, Layout, theme tokens)
- **Zustand 5** (memoryLeakConsoleStore, workspaceStore, logsStore)
- **React Router 7** (useParams, useNavigate, Outlet, useOutletContext)
- **@xyflow/react v11** (NodeProps, EdgeProps, ReactFlowProvider)
- **lucide-react** + **@ant-design/icons** for icons

### State Management
- `consoleStore` — scan lifecycle, events, report data, UI state
- `workspaceStore` — GitHub connection, repos, workspaces CRUD
- `logsStore` — SSE log entries, level filtering, pause/download

## Important Notes

### Docker-in-Docker Considerations
- Static server runs LeakGuard via Docker, requiring `/var/run/docker.sock` mount
- When static server itself runs in a container, it needs Docker socket access
- LeakGuard runtime container must be available on the same Docker daemon

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
