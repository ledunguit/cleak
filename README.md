# Thesis Workspace

Root workspace for a Master's thesis on LLM-orchestrated memory leak
investigation for C/C++ repositories.

This repository is an umbrella workspace, not a single implementation repo. It
keeps the thesis components together at one top level:

- `MCP-Vul`: control plane, orchestration, and future judge/explanation layer
- `mcp-memory-static-analysis-server`: static MCP server for leak investigation
- `mcp-dynamic-analysis-server`: dynamic MCP server for runtime evidence
- `mcp-memory-common`: shared leak-centric schemas
- `leak_guard_tool`: existing analyzer codebase for future MCP integration

The intended system shape is:

1. static and dynamic analyzers expose MCP tools
2. `MCP-Vul` coordinates investigation across a target C/C++ repo
3. findings are normalized into shared leak bundles
4. the system returns leak verdicts, explanations, and repair guidance

For the detailed workspace-level architecture, see
[THESIS_WORKSPACE_OVERVIEW.md](THESIS_WORKSPACE_OVERVIEW.md).

## Demo Slice

This workspace now includes a small repeatable demo corpus, separate MCP server
compose files, and a full demo compose file for the web application:

- `demo/memory_leak_corpus/simple_leak`
- `docker-compose.thesis-demo.yml`
- `scripts/run_memory_leak_demo.sh`
- `scripts/run_memory_leak_app.sh`
- `scripts/run_memory_leak_full_demo.sh`

Typical flow:

```bash
docker compose -f docker-compose.thesis-demo.yml up --build
```

This starts the web app, static MCP server, and dynamic MCP server. Open
`http://127.0.0.1:8090` to use the workspace picker, progress stream, and report
viewer.

To scan your own repository from the UI, place or bind-mount it under
`./targets`. That directory is mounted into the stack as `/workspace/targets`,
and the UI is configured to list both:

- `/workspace/demo/memory_leak_corpus`
- `/workspace/targets`

Example:

```bash
mkdir -p targets
ln -s /absolute/path/to/my-c-project targets/my-c-project
scripts/run_memory_leak_full_demo.sh
```

Then choose `my-c-project` from the UI workspace list.

For the CLI scan flow, start only the MCP servers you need using their own
compose files or the full demo compose above. Then run:

```bash
scripts/run_memory_leak_demo.sh
```

The demo writes JSON, Markdown, HTML, and snapshot outputs under `results/demo/`.

For corpus-style evaluation:

```bash
scripts/run_memory_leak_corpus.sh
```

The corpus runner reads `demo/memory_leak_corpus/corpus_manifest.json` and writes
per-case reports plus `summary.json` under `results/corpus/`.

For the local web UI:

```bash
scripts/run_memory_leak_app.sh
```

Then open `http://127.0.0.1:8090`. The UI lets you choose an allowed workspace,
start a scan, watch progress/tool logs, and view JSON/Markdown/HTML/snapshot
reports.

To run the full Docker demo with one command:

```bash
scripts/run_memory_leak_full_demo.sh
```
