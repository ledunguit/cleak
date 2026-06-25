# System Sequence Diagrams

Memory-leak investigation system. The orchestrator is the **TUI** (`leak-inspector-tui`), a standalone Bun/Ink CLI driving a native agent loop via `@cleak/agent-core`. It produces the data contract `LeakCandidate` → `LeakBundle` → `VerdictResult` → `ScanReport`.

The TUI invokes the `static-analyzer` / `dynamic-analyzer` services over **MCP-over-HTTP** and writes report artifacts to disk.

> An earlier web orchestration path (NestJS `control-plane` + React `leak-inspector-ui`) is preserved on branch `web-implementation`; it is not part of `master`.

---

## 1. High-level overview

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant TUI as leak-inspector-tui
    participant Static as static-analyzer (MCP)
    participant Dynamic as dynamic-analyzer (MCP)
    participant LLM as LLM Provider<br/>(Anthropic / OpenAI)

    User->>TUI: Start scan (repo + mode)
    TUI->>Static: Discovery (index + candidate scan)
    Static-->>TUI: Candidates → LeakBundles

    loop Investigation (agentic)
        TUI->>LLM: Decide next action (llm_assisted)
        LLM-->>TUI: Action (tool / judge / finish)
        TUI->>Static: Static tools (AST, call graph, ...)
        TUI->>Dynamic: Build + sanitizers (ASan/LSan/Valgrind)
        Dynamic-->>TUI: Runtime evidence
    end

    TUI->>LLM: Judge bundles (verdict + repair)
    LLM-->>TUI: Verdicts
    TUI->>TUI: Write report artifacts to results/<scanId>/
    TUI-->>User: Verdicts + evidence + diff
```

---

## 2. TUI — leak-inspector-tui (native agent-core loop)

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
- **Transport**: the TUI talks to the analyzers via agent-core `McpClient` over HTTP (MCP). The analyzers still ship gRPC server code (driven by the `proto/` definitions), but it has no consumer on `master`; docker-compose defaults them to `TRANSPORT_MODE=mcp`.
- **Analysis modes**: `no_llm` (deterministic heuristic) vs `llm_assisted` (LLM plans actions & judges) — same report contract for comparability.
- **Verdict enrichment**: `enrichLeakVerdict()` adds `rootCause` + `repairDiff` to each `VerdictResult`.
