# Sơ đồ kiến trúc hệ thống (ASCII)

> Chỉ sơ đồ. Chi tiết: [ARCHITECTURE.md](./ARCHITECTURE.md).

## 1. Topology — orchestrator + analyzers

```text
                          ┌──────────────────────────────────────────────────┐
                          │              ORCHESTRATOR (headless)             │
                          │         leak-inspector-tui  (@cleak/cli)         │
                          │         Ink CLI/TUI · native tool-calling        │
                          │       packages/agent-core: queryLoop · MCP       │
                          │             client · callModel (SSE)             │
                          └───┬─────────────┬───────────────┬────────────┬───┘
            MCP HTTP /mcp     │             │ MCP HTTP /mcp │  HTTP SSE  │ file I/O
                              v             v               │            v
        ┌──────────────────────────┐  ┌─────────────────────┴───┐  ┌──────────────────────────┐
        │   static-analyzer        │  │   dynamic-analyzer      │  │  results/<scanId>/       │
        │   NestJS + Tree-sitter   │  │   NestJS                │  │  snapshot.json           │
        │   MCP :50061 · 11 tools  │  │   MCP :50062 · 9 tools  │  │  report.{json,md,html}   │
        │  candidateScan · AST ·   │  │  buildTarget · Valgrind │  │  events.jsonl            │
        │  callGraph · funcSummary │  │  ASan · LSan · runBinary│  │  metrics.json            │
        │  pathConstraints ·       │  │  (Linux/Docker only)    │  └──────────────────────────┘
        │  ownership · scan-build  │  └─────────────────────────┘
        └──────────────────────────┘            docker net: mcpvul-net
                              │
                              │  HTTP SSE (streaming)
                              v
                  ┌──────────────────────────────┐
                  │   LLM gateway  :20128         │
                  │  mimo / OpenAI / Anthropic /  │
                  │  openai-compat                │
                  └──────────────────────────────┘
```

## 2. Orchestrator — pipeline HYBRID

```text
   cli.ts scan|tui
        │
        v
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ POLICY · LLM host-side   (tuỳ chọn; BỎ QUA ở no_llm / benchmark)         │
 │                                                                          │
 │   allocatorProfiler ──► strategist                                       │
 │   headers/src →         → {runDynamic, judge, staticDepth}               │
 │   {allocators,                                                           │
 │    deallocators,          grep-verify + cache .cleak/                    │
 │    ownershipNotes}                                                       │
 └────────────────────────────────────┬─────────────────────────────────────┘
                                      │  extraAllocators/Deallocators, ownershipNotes
                                      v
                            scanController.runScan
                                      │
        ┌─────────────────────────────┴───────────────────────────────┐
        │ DISCOVERY (tất định)                                        │
        │   walkCFiles (bỏ test/fuzz/vendor)                          │
        │     → static.candidateScan (MCP, +allocators)               │
        │     → CandidateManager → LeakBundle[]                       │
        │       (libc · factory · C++ new · param-ownership)          │
        └─────────────────────────────┬───────────────────────────────┘
                                      v
        ┌─────────────────────────────┴───────────────────────────────┐
        │ STATIC ENRICHMENT (tất định · STATIC_ENRICH=on)             │
        │   functionSummary + pathConstraints (MCP)                   │
        │     → foldStaticResult → bundle.staticEvidence              │
        │       (allocFreePairs · feasibleLeakPaths)                  │
        │       CFG heuristic — NO SMT (Z3 đã gỡ)                     │
        └──────────────┬────────────────────────────────┬─────────────┘
                       │                                │
                       │ (chỉ llm_assisted)             │ (no_llm: đi thẳng judge)
                       v                                │
        ┌───────────────────────────────────────────┐   │
        │ INVESTIGATION (agentic · llm_assisted)    │   │
        │   investigationPhase → agent-core         │   │
        │     queryLoop                             │   │
        │   ┌────────────────────────────────────┐  │   │
        │   │ sub-agent (native tool-calling)    │  │   │
        │   │   ▲                            │   │  │   │
        │   │   │ MCP static/dynamic         │   │  │   │
        │   │   │ + recipe tất định:         │   │  │   │
        │   │   └ buildTarget → lsanRun ◄────┘   │  │   │
        │   └────────────────────────────────────┘  │   │
        └──────────────┬────────────────────────────┘   │
                       │                                │
                       v                                v
        ┌───────────────────────────────────────────────────────────────┐
        │ HYBRID JUDGE                                                  │
        │   heuristic path-sensitive (MỌI bundle)                       │
        │   + LLM/consensus (BORDERLINE) + ownershipNotes + judgeTuner  │
        └──────────────────────────────┬────────────────────────────────┘
                                       v
                         LeakReporting.buildReport
                                       │
                                       v
                              results/<scanId>/
                                       :
        (AgentEvent / ScanEvent  ┄┄┄►  Ink store / TUI, suốt pipeline)
```

## 3. Luồng dữ liệu — LeakBundle

```text
   LeakCandidate ──┐
   (alloc site)    │
                   ├──►  LeakBundle  ──►  VerdictResult           ──►  ScanReport
   Evidence ───────┘                     verdict · confidence ·        json · md ·
   (asan · lsan ·                        rootCause · repairDiff        html · snapshot
    valgrind ·
    scan-build ·
    heuristic)
```

## 4. Nguyên tắc cốt lõi

**LLM sở hữu POLICY, engine sở hữu MECHANISM.** LLM khám phá thứ *khác nhau theo project*
(allocator/deallocator, ownership, strategy, judge-tuning) → xuất profile có cấu trúc → grep-verify →
cache `.cleak/` → **đông cứng cho benchmark** → nạp vào tham số engine tất định (parse/CFG/pairing/scoring).
⇒ đường eval **0 LLM non-deterministic** (Tier-1 determinism); thêm project mới = **0 dòng code**.
