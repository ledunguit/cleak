# System Sequence Diagrams

Memory-leak investigation system. The system exposes **two orchestration paths** that share the same data contract (`LeakCandidate` → `LeakBundle` → `VerdictResult` → `ScanReport`):

1. **Web path** — `control-plane` (NestJS, BullMQ worker, SSE to UI)
2. **TUI path** — `leak-inspector-tui` (Bun CLI, native agent loop via `@mcpvul/agent-core`)

Both invoke the same `static-analyzer` / `dynamic-analyzer` services (gRPC by default, MCP-over-HTTP optional) and produce the same report.

---

## 1. High-level overview

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Client as UI / TUI
    participant Orch as Orchestrator<br/>(control-plane | tui)
    participant Static as static-analyzer
    participant Dynamic as dynamic-analyzer
    participant LLM as LLM Provider<br/>(Anthropic / OpenAI)
    participant DB as PostgreSQL

    User->>Client: Start scan (repo + mode)
    Client->>Orch: Create scan
    Orch->>Static: Discovery (index + candidate scan)
    Static-->>Orch: Candidates → LeakBundles

    loop Investigation (agentic)
        Orch->>LLM: Decide next action (llm_assisted)
        LLM-->>Orch: Action (tool / judge / finish)
        Orch->>Static: Static tools (AST, call graph, ...)
        Orch->>Dynamic: Build + sanitizers (ASan/LSan/Valgrind)
        Dynamic-->>Orch: Runtime evidence
    end

    Orch->>LLM: Judge bundles (verdict + repair)
    LLM-->>Orch: Verdicts
    Orch->>DB: Persist report
    Orch-->>Client: Stream events / final report
    Client-->>User: Verdicts + evidence + diff
```

---

## 2. Web path — control-plane (deterministic + heuristic/LLM loop)

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as leak-inspector-ui
    participant Ctrl as ScanController
    participant Svc as ScanService
    participant Q as BullMQ (ScanProcessor)
    participant Orch as ScanOrchestratorService
    participant Plan as InvestigationPlanner
    participant Judge as JudgeService
    participant Rep as ReportingService
    participant Static as static-analyzer
    participant Dynamic as dynamic-analyzer
    participant LLM as LLM Provider
    participant DB as PostgreSQL

    User->>UI: Configure repo + scan options
    UI->>Ctrl: POST /api/scans
    Ctrl->>Svc: createScan(dto)
    Svc->>DB: Insert ScanEntity (status=queued)
    Svc-->>UI: { scanId, status: queued }
    Svc->>Q: enqueue detached job
    UI->>Ctrl: GET /api/scans/:id/events (SSE)

    Note over Q,Orch: Async worker (concurrency 2)
    Q->>Svc: runScanPipeline(jobData)

    rect rgb(238,244,255)
    Note right of Svc: PREFLIGHT (optional) + WORKSPACE
    Svc->>Svc: RuntimeDiagnostics preflight
    Svc-->>UI: PREFLIGHT_* (SSE)
    Svc->>Svc: materialize workspace + discover build
    Svc-->>UI: WORKSPACE_* / BUILD_PLAN_SELECTED (SSE)
    end

    Svc->>Orch: run(deps)

    rect rgb(236,250,240)
    Note right of Orch: DISCOVERY
    Orch->>Static: repo.index_files(workspace)
    Static-->>Orch: file list
    loop per file
        Orch->>Static: memory.candidate_scan(file, content)
        Static-->>Orch: candidates
    end
    Orch->>Orch: CandidateManager.ingest → LeakBundles
    Orch-->>UI: DISCOVERY_* / CANDIDATES_SCANNING (SSE)
    end

    rect rgb(255,248,236)
    Note right of Orch: INVESTIGATION (max N turns)
    loop each turn
        Orch->>Plan: decideNextAction(state, bundles, catalog, mode)
        alt mode = llm_assisted
            Plan->>LLM: prompt orchestrator
            LLM-->>Plan: AgentDecision
        else mode = no_llm
            Plan->>Plan: heuristic strategy
        end
        Plan-->>Orch: decision (actionKind)

        alt RUN_STATIC_TOOL
            Orch->>Static: ast_scan / call_graph / path_constraints / ...
            Static-->>Orch: structural context → staticContext[bundleId]
        else RUN_LEAKGUARD (Clang scan-build)
            Orch->>Static: memory.leakguard_run(project, buildCmd)
            Static-->>Orch: findings → evidence
            Orch-->>UI: LEAKGUARD_* (SSE)
        else RUN_DYNAMIC
            Orch->>Dynamic: build_target(project, buildCmd)
            Dynamic-->>Orch: binary
            Orch->>Dynamic: asan.run / lsan.run / valgrind.analyze
            Dynamic-->>Orch: runtime evidence → bundle.evidence
            Orch-->>UI: DYNAMIC_* (SSE)
        else JUDGE_BUNDLE
            Orch->>Judge: judgeBundle(bundle, staticContext, mode)
            alt llm_assisted
                Judge->>LLM: judge prompt
                LLM-->>Judge: verdict + rootCause + repairDiff
            else fallback
                Judge->>Judge: judgeHeuristically()
            end
            Judge-->>Orch: VerdictResult
        end
        Orch-->>UI: AGENT_TURN_* / AGENT_TOOL_RESULT (SSE)
    end
    end

    rect rgb(245,238,255)
    Note right of Orch: JUDGING + REPORTING
    Orch->>Judge: judge remaining bundles (heuristic)
    Judge-->>Orch: verdicts
    Orch->>Rep: buildReport(bundles, metadata, decisions)
    Rep-->>Orch: ScanReport (JSON/MD/HTML/PDF/CSV)
    Orch-->>UI: JUDGING_* / REPORTING_* (SSE)
    end

    Orch->>DB: save report on ScanEntity
    Orch-->>UI: COMPLETED (SSE)
    UI->>Ctrl: GET /api/scans/:id/report?format=...
    Ctrl-->>UI: report
    UI-->>User: Verdict table + evidence + diff
```

---

## 3. TUI path — leak-inspector-tui (native agent-core loop)

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant CLI as cli.ts
    participant Scan as ScanController.runScan
    participant Phase as buildInvestigationPhase
    participant Loop as agent-core queryLoop
    participant LLM as callModel (LLM)
    participant Domain as Domain tools<br/>(list/read/record/finalize)
    participant Static as static-analyzer (MCP)
    participant Dynamic as dynamic-analyzer (MCP)
    participant Rep as LeakReporting

    User->>CLI: bun leak-tui scan --repo --mode llm_assisted
    CLI->>Scan: runScan(input, deps)

    rect rgb(236,250,240)
    Note right of Scan: DISCOVERY (deterministic)
    Scan->>Static: candidateScan (host injects file content)
    Static-->>Scan: candidates → CandidateManager
    end

    Scan->>Phase: build toolset + prompts
    Phase->>Phase: loadMcpTools(static) + withHostContent()
    Phase->>Phase: loadMcpTools(dynamic) + withHostPathMapping()
    Phase->>Phase: buildDomainTools(candidates, onVerdict)
    Phase-->>Scan: InvestigationPhase (tools, systemPrompt)

    rect rgb(255,248,236)
    Note right of Loop: INVESTIGATION (native tool-calling)
    Scan->>Loop: queryLoop(systemPrompt, messages, tools, maxTurns)
    loop until finalize_report or maxTurns
        Loop->>LLM: callModel(history, tools)
        LLM-->>Loop: assistant text + tool_use[]
        par concurrent-safe tools (parallel, cap 10)
            Loop->>Domain: list_candidates / read_file
            Domain-->>Loop: tool_result
            Loop->>Static: astScan / callGraph / ... (content injected)
            Static-->>Loop: tool_result
        and dynamic / sequential tools
            Loop->>Dynamic: build + asan/lsan/valgrind (path mapped)
            Dynamic-->>Loop: tool_result
            Loop->>Domain: record_verdict / record_evidence
            Domain-->>Loop: bundle updated
        end
        Loop-->>CLI: AgentEvent (turn_start, text, tool_use, tool_result)
        Note over CLI: TUI renders live
    end
    Loop-->>Scan: { reason, turns, decisions, transcript, usage }
    end

    rect rgb(245,238,255)
    Note right of Scan: JUDGING + REPORTING
    Scan->>Scan: judgeHeuristically() for un-verdicted bundles
    Scan->>Rep: buildReport(bundles)
    Rep-->>Scan: ScanReport
    end
    Scan-->>User: report (headless) / TUI summary
```

---

## Notes

- **Optional phases** (skipped unless the agent chooses them): `PREFLIGHT`, `LEAKGUARD` (Clang `scan-build`), `DYNAMIC`.
- **Transport**: `TRANSPORT_MODE` env selects `grpc` (default) | `mcp` | `both`. control-plane uses gRPC clients (or MCP adapter); TUI uses agent-core `McpClient` over HTTP.
- **Analysis modes**: `no_llm` (deterministic heuristic) vs `llm_assisted` (LLM plans actions & judges) — same report contract for comparability.
- **Verdict enrichment**: `enrichLeakVerdict()` adds `rootCause` + `repairDiff` to each `VerdictResult`.
