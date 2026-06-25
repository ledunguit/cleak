# leak-inspector-tui

An agentic terminal investigator for C/C++ memory leaks. It drives the project's
static/dynamic analysis MCP servers with a native tool-calling loop — the model
decides which analyses to run on each allocation candidate, gathers evidence, and
records a verdict — then renders the same report formats the control plane does,
so its outputs are directly comparable for thesis experiments.

It is a lighter, experiment-friendly alternative to the web UI: one binary, two
surfaces (interactive TUI + headless batch), and reproducible artifacts per scan.

## Architecture

```
packages/agent-core         framework-free agentic core (reusable):
  loop.ts                   async-generator turn loop (stream → tools → results → repeat)
  tool.ts                   Tool abstraction + buildTool() defaults
  providers/                callModel for local | openai | anthropic (native tool-calling)
  mcp/                      Streamable-HTTP MCP client + tool wrapping (tools/list → Tool)

apps/leak-inspector-tui
  domain/                   systemPrompt, domain tools (read_file, record_verdict, …),
                            CandidateManager, path resolver, heuristic judge wrapper
  orchestrator/             HYBRID scan controller + ScanEvent emitter + investigation phase
  surfaces/headless.ts      batch runner → results/<scanId>/ + JSONL event log
  surfaces/tui/             Ink UI (timeline, tool cards, spinner, permission overlay)

packages/common/analysis    shared (with the control plane) report renderers + heuristic
                            analysis + heuristic judge → byte-identical verdicts/snapshots
```

### HYBRID orchestration

```
discovery (deterministic: indexFiles + candidateScan)
  → investigation (agentic native tool-calling loop; llm_assisted only)
  → judging (deterministic heuristic finalizer for un-verdicted bundles)
  → reporting (json / markdown / html / snapshot)
```

Deterministic discovery + judging keep the candidate set and verdict synthesis
reproducible; the investigation phase is where the model is genuinely agentic.

## Usage

Start the analyzers in MCP mode (they default to gRPC):

```bash
(cd apps/static-analyzer  && TRANSPORT_MODE=mcp MCP_HTTP_PORT=50061 bun run dev)
(cd apps/dynamic-analyzer && TRANSPORT_MODE=mcp MCP_HTTP_PORT=50062 bun run dev)
```

Then:

```bash
# discover/verify analyzer tools
bun apps/leak-inspector-tui/src/cli.ts tools

# headless scan (writes results/<scanId>/)
bun apps/leak-inspector-tui/src/cli.ts scan --repo demo/memory_leak_corpus/early_return_leak --mode llm_assisted

# interactive TUI (needs a terminal)
bun apps/leak-inspector-tui/src/cli.ts tui
#   /scan <path>  /mode no_llm|llm_assisted  /dynamic off|selective|aggressive  /report  /tools  /quit
```

### Outputs (`results/<scanId>/`)

- `snapshot.json` — compact, machine-comparable findings (thesis evaluation format)
- `report.json` / `report.md` / `report.html` — full report
- `events.jsonl` — the ScanEvent stream (phase + agent activity)
- `transcript.json` — the full agent message history (reproducibility / audit)

## Configuration (env)

| var | meaning | default |
|---|---|---|
| `LLM_PROVIDER` | `local` \| `openai` \| `anthropic` | `local` |
| `LOCAL_LLM_BASE_URL` / `LOCAL_LLM_MODEL` / `LOCAL_LLM_API_KEY` | local OpenAI-compatible gateway | `localhost:20128/v1` |
| `STATIC_ANALYZER_MCP_URL` / `DYNAMIC_ANALYZER_MCP_URL` | analyzer endpoints | `localhost:50061` / `:50062` |
| `AGENT_MAX_TURNS` | investigation turn budget | `15` |

The LLM key is read from the repo-root `.env` (or `apps/leak-inspector-tui/.env`)
automatically (the TUI loads it on start). Host runs rewrite
`host.docker.internal` → `localhost`; set `IN_CONTAINER=1` to keep the container
hostname.

## Thesis experiment scripts

```bash
bun scripts/evaluate-corpus.ts [no_llm|llm_assisted] [limit]   # score vs expected_leak_count
bun scripts/compare-modes.ts [limit]                           # no_llm vs llm_assisted
bun scripts/run-local-scan-smoke.ts                            # one-scan sanity check
bun scripts/mcp-contract-test.ts                               # analyzer tool catalog check
```

## Notes

- **Dynamic analysis** (sanitizers / valgrind) and the **Clang-SA / scan-build**
  deep-static slot require Linux/Docker; on macOS the analyzers run those phases
  inside the container. The agent gates them behind `--dynamic` and interactive
  approval. (The "leakguard" tool slot now runs Clang scan-build, not the removed
  LeakGuard third-party tool.)
- In a dev box where the docker stack already holds `50061/50062` in gRPC mode,
  run the MCP analyzers on alternate ports (e.g. `50071/50072`) and pass
  `--static-url` / `--dynamic-url`.
