# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Master's thesis workspace on LLM-orchestrated memory leak investigation for C/C++ repositories. The system uses a microservices architecture with MCP (Model Context Protocol) servers for static and dynamic analysis, coordinated by a central control plane.

## Architecture

The workspace consists of five main components:

### MCP-Vul (Control Plane)
- Orchestrates memory leak investigation across target C/C++ repositories
- Connects to static and dynamic MCP analyzer servers over HTTP
- Manages candidate discovery, evidence expansion, clustering, and judging
- Produces JSON, Markdown, HTML, and snapshot reports
- Includes a web application for UI-based scanning

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
- Used by orchestrator and both analyzer servers

### leak_guard_tool
- Existing memory leak analyzer codebase
- Integrated via static server's LeakGuard adapter
- Not the main control plane, but a wrapped tool

## Communication Flow

1. Static and dynamic analyzers expose MCP tools over HTTP
2. MCP-Vul coordinates investigation by calling these tools
3. Findings are normalized into shared leak bundles (from mcp-memory-common)
4. Judge layer produces verdicts, explanations, and repair suggestions
5. Reports are emitted in multiple formats for evaluation

## Common Commands

### Full System Demo (Recommended)
```bash
# Start all services (web app + MCP servers) with Docker
./scripts/run_memory_leak_full_demo.sh

# Or manually:
docker compose -f docker-compose.yml up --build

# Access web UI at http://127.0.0.1:8090
```

### CLI Scan (Single Repository)
```bash
# Start MCP servers first (in separate terminals or via Docker)
cd mcp-memory-static-analysis-server
docker compose up --build  # Port 8081

cd mcp-dynamic-analysis-server
docker compose up --build  # Port 8080

# Run scan
./scripts/run_memory_leak_demo.sh [target_repo_path]

# Results written to results/demo/
```

### Corpus Evaluation
```bash
# Run all test cases in demo/memory_leak_corpus/corpus_manifest.json
./scripts/run_memory_leak_corpus.sh

# Results written to results/corpus/ with summary.json
```

### MCP-Vul Commands (from MCP-Vul directory)
```bash
# Single repository scan
mcp-vul-memory-scan /path/to/c-repo \
  --limit 500 \
  --build-command "make CC=clang" \
  --output results/report.json \
  --markdown-output results/report.md \
  --html-output results/report.html \
  --snapshot-output results/snapshot.json

# Batch corpus scan
mcp-vul-memory-batch ../demo/memory_leak_corpus/corpus_manifest.json \
  --output-dir ../results/corpus

# Compare experiment snapshots
mcp-vul-memory-compare results/static-only/snapshot.json results/orchestrated/snapshot.json

# Run web application
mcp-vul-memory-app --host 127.0.0.1 --port 8090
```

### Static Server Commands (from mcp-memory-static-analysis-server directory)
```bash
# Run via Docker (recommended)
docker compose up --build

# Or run locally via stdio
mcp-memory-static-server

# Or run locally via HTTP
mcp-memory-static-server --transport http --host 0.0.0.0 --port 8081

# Test endpoint
curl -s http://localhost:8081/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### Dynamic Server Commands (from mcp-dynamic-analysis-server directory)
```bash
# Run via Docker (required on macOS, Valgrind is Linux-only)
docker compose up --build

# Build example vulnerable binaries
docker compose exec -T mcp-da make -C examples/vulnerable

# Run locally via stdio (Linux only)
mcp-da-server

# Run locally via HTTP (Linux only)
mcp-da-server --transport http --host 0.0.0.0 --port 8080

# Test endpoint
curl -s http://localhost:8080/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Environment Configuration

### Key Environment Variables

**MCP-Vul (Control Plane):**
- `MCP_STATIC_SERVER_URL`: Static MCP server URL (default: http://localhost:8081/mcp)
- `MCP_DYNAMIC_SERVER_URL`: Dynamic MCP server URL (default: http://localhost:8080/mcp)
- `MEMORY_LEAK_JUDGE_MODE`: `heuristic` or `llm`
- `MEMORY_LEAK_JUDGE_SCOPE`: `selective` or `all`
- `MEMORY_LEAK_STATIC_EXPANSION_MODE`: `minimal`, `balanced`, or `full`
- `LLM_PROVIDER`: `local`, `openai`, or `anthropic`
- `LOCAL_LLM_BASE_URL`: Local LLM endpoint (e.g., http://host.docker.internal:20128/v1)

**Static Server:**
- `LEAKGUARD_REPO_ROOT`: Path to leak_guard_tool repository
- `LEAKGUARD_DOCKER_IMAGE`: LeakGuard Docker image (default: leakguard-tool:dev)
- `LEAKGUARD_DOCKER_PLATFORM`: Platform for LeakGuard (default: linux/amd64)

**Dynamic Server:**
- `WORKSPACE_ROOT`: Root directory for allowed execution paths
- `RUNS_DIR`: Directory for storing run artifacts
- `VALGRIND_BIN`: Path to Valgrind binary (default: valgrind)

**Web Application:**
- `MEMORY_LEAK_APP_WORKSPACE_ROOTS`: Allowed workspace roots (colon-separated)
- `MEMORY_LEAK_APP_ARTIFACT_DIR`: Where scan events and reports are stored
- `MEMORY_LEAK_APP_DB_PATH`: SQLite database path for scan metadata

See `.env.example` for complete configuration template.

## Testing Target Repositories

To scan your own C/C++ repository:

1. Place or symlink it under `./targets/`:
   ```bash
   mkdir -p targets
   ln -s /absolute/path/to/my-c-project targets/my-c-project
   ```

2. Start the full demo stack:
   ```bash
   ./scripts/run_memory_leak_full_demo.sh
   ```

3. Open http://127.0.0.1:8090 and select your project from the workspace list

The UI is configured to list both:
- `/workspace/demo/memory_leak_corpus` (built-in test cases)
- `/workspace/targets` (your custom repositories)

## Development Setup

### Development Mode (Host with Hot Reload)

For rapid development of UI and app server without Docker overhead:

**Prerequisites:**
- Python 3.11+ (3.12 recommended)
- Node.js 18+ and npm
- Docker (for MCP servers only)

**Quick Start:**

1. **Setup Python environment:**
```bash
cd MCP-Vul
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -e ".[dev]"
pip install -r requirements-dev.txt
```

2. **Setup frontend:**
```bash
cd frontend
npm install
cd ..
```

3. **Start MCP servers in Docker:**
```bash
cd ..
docker compose -f docker-compose.thesis-demo.yml up memory-static-analysis dynamic-analysis
```

4. **In a new terminal, start development environment:**
```bash
cd MCP-Vul
./dev.sh
```

This starts:
- Frontend dev server at http://localhost:5173 (Vite hot reload)
- Backend server at http://127.0.0.1:8090 (watchdog auto-reload)

Press Ctrl+C to stop all services.

**Running Services Separately:**

Backend only (with auto-reload):
```bash
cd MCP-Vul
./dev-backend.sh
```

Frontend only:
```bash
cd MCP-Vul/frontend
npm run dev
```

Backend without auto-reload:
```bash
cd MCP-Vul
python -m src.memory_leak_app.server --host 127.0.0.1 --port 8090
```

**Hot Reload Behavior:**
- **Frontend:** Vite automatically reloads on file changes in `frontend/src/`
- **Backend:** Watchdog restarts server when `.py` files change in `src/`
- **Note:** Backend restart takes ~2-3 seconds, active SSE connections will disconnect

**Environment Variables:**

Create `.env` file in `MCP-Vul/` directory:
```bash
# MCP Server URLs (Docker containers)
MCP_STATIC_SERVER_URL=http://127.0.0.1:8081/mcp
MCP_DYNAMIC_SERVER_URL=http://127.0.0.1:8080/mcp

# Workspace configuration
MEMORY_LEAK_APP_WORKSPACE_ROOTS=/path/to/your/c-repos
MEMORY_LEAK_APP_ARTIFACT_DIR=./results/app_scans

# LLM configuration
LLM_PROVIDER=local
LOCAL_LLM_BASE_URL=http://localhost:20128/v1
LOCAL_LLM_MODEL=gh/gpt-5-mini
MEMORY_LEAK_JUDGE_MODE=heuristic
```

**Why MCP Servers Stay in Docker:**
- Dynamic analysis requires Valgrind (Linux-only)
- LeakGuard needs specific build environment
- Static analysis needs Docker-in-Docker for LeakGuard
- Binary compatibility issues on macOS

### Production Setup (Full Docker)

All Python components require Python 3.11+. Use pyenv or uv for environment management:

```bash
# Using pyenv
pyenv virtualenv 3.12.8 thesis-env
pyenv local thesis-env

# Install each component
cd MCP-Vul && pip install -e .[dev]
cd mcp-memory-static-analysis-server && pip install -e .
cd mcp-dynamic-analysis-server && pip install -e .[test]
cd mcp-memory-common && pip install -e .
```

### Docker Requirements
- Docker and Docker Compose are required for full system operation
- Static server needs Docker access to run LeakGuard
- Dynamic server requires Docker on macOS (Valgrind is Linux-only)
- LeakGuard runtime container must be built before static server can use it

### Running Tests
```bash
# MCP-Vul tests
cd MCP-Vul && pytest

# Dynamic server tests
cd mcp-dynamic-analysis-server && pytest

# Static server tests
cd mcp-memory-static-analysis-server && pytest
```

### Troubleshooting Development Mode

**Port already in use:**
```bash
# Find and kill process using port 8090
lsof -ti:8090 | xargs kill -9
```

**Frontend not connecting to backend:**
- Check `frontend/vite.config.js` proxy configuration
- Ensure backend is running on port 8090
- Check browser console for CORS errors

**Backend not reloading:**
- Ensure watchdog is installed: `pip install watchdog[watchmedo]`
- Check that changes are in `src/` directory
- Try manual restart if needed

**MCP servers not reachable:**
- Verify Docker containers are running: `docker ps`
- Check ports 8080 and 8081 are accessible
- Review container logs: `docker logs <container_id>`

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

## Important Notes

### Docker-in-Docker Considerations
- Static server runs LeakGuard via Docker, requiring `/var/run/docker.sock` mount
- When static server itself runs in a container, it needs Docker socket access
- LeakGuard runtime container must be available on the same Docker daemon

### Valgrind Platform Limitations
- Valgrind is Linux-only and will not work natively on macOS
- Always use Docker for dynamic analysis on macOS
- The dynamic server container provides a Linux environment for Valgrind

### Workspace Security
- Dynamic server validates all executable paths within `WORKSPACE_ROOT`
- Web app only allows scanning repositories under configured `WORKSPACE_ROOTS`
- Artifacts are isolated per run ID to prevent cross-contamination

### Report Formats
The system produces four output formats:
- **JSON**: Machine-readable structured findings
- **Markdown**: Human-readable text report
- **HTML**: Styled web-viewable report
- **Snapshot**: Experiment comparison format with metadata

### Legacy Code
Historical multi-CWE MVP code is archived under `MCP-Vul/legacy/multi_cwe_mvp/` and is not part of the active memory-leak build/test surface.
