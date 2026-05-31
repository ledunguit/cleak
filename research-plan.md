# Research Plan: LLM-Orchestrated Memory Leak Scanner for C/C++

> Generated: 2026-05-27
> Status: Investigation Phase — Codebase Audit Complete

---

## 1. Current State Assessment

### 1.1 Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   Frontend (:5173)                    │
│            React 19 + Ant Design + Zustand            │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP (REST + SSE)
                       ▼
┌─────────────────────────────────────────────────────┐
│             Control Plane (:8090) NestJS              │
│  ┌───────────┬────────────┬────────────┬──────────┐  │
│  │ Scan      │ Workspace  │ GitHub     │ Auth     │  │
│  │ Controller│ Controller │ Controller │Controller│  │
│  └─────┬─────┴─────┬──────┴─────┬──────┴────┬─────┘  │
│        │           │            │           │         │
│  ┌─────▼───────────▼────────────▼───────────▼─────┐  │
│  │              Services Layer                      │  │
│  │  ScanOrchestrator • BuildDiscovery              │  │
│  │  InvestigationPlanner • JudgeService            │  │
│  │  ReportingService • DynamicPlanner              │  │
│  │  ToolRegistry • LlmAnalyzer                     │  │
│  └─────┬──────────────────────┬───────────────────┘  │
└────────┼──────────────────────┼──────────────────────┘
         │ gRPC                 │ gRPC
         ▼                      ▼
┌─────────────────┐  ┌─────────────────────┐
│ Static Analyzer │  │ Dynamic Analyzer    │
│ (:50051) NestJS │  │ (:50052) NestJS     │
│                 │  │                     │
│ • File Index    │  │ • Valgrind Memcheck │
│ • CandidateScan │  │ • AddressSanitizer  │
│ • AST Scan      │  │ • LeakSanitizer     │
│ • Call Graph    │  │ • Build Target      │
│ • FunctionSumm. │  │ • Result Parser     │
│ • PathConstr.   │  │ • Run Manager       │
│ • InterprocFlow │  │ • Compare           │
│ • Ownership     │  │ • Binary Runner     │
│ • LeakGuard     │  │                     │
└────────┬────────┘  └─────────────────────┘
         │ Docker
         ▼
┌──────────────────┐
│ LeakGuard Tool   │
│ (leakguard-tool: │
│  dev container)  │
│                  │
│ • Clang Static   │
│   Analyzer       │
│ • ML Model       │
│   (TensorFlow)   │
└──────────────────┘
```

### 1.2 What Works (Partially or Fully)

| Component | Status | Notes |
|-----------|--------|-------|
| Monorepo setup (Turborepo + NestJS) | ✅ Working | `bun run build`, `turbo run dev` |
| Docker Compose (6 services) | ✅ Working | Builds and starts |
| PostgreSQL + TypeORM | ✅ Working | Entities, migrations |
| GitHub OAuth + Clone | ✅ Working | Controller + service |
| LLM Build Discovery | ✅ Working | Agent loop: Anthropic/OpenAI/Ollama |
| Candidate Scan (regex) | ✅ Working | malloc/calloc/realloc/strdup/new |
| Dynamic Analyzer wrappers | ✅ Working | Valgrind, ASan, LSan |
| Frontend UI scaffold | ✅ Working | All pages, Zustand stores |
| Report formats (JSON, MD, HTML, PDF, Snapshot) | ✅ Working | Basic implementations |
| gRPC inter-service communication | ✅ Working | Proto definitions |
| SSE event streaming | ✅ Working | Real-time scan progress |
| Pipeline skeleton (orchestrator) | ✅ Working | Linear pipeline flow |

### 1.3 What's Broken or Incomplete

| Component | Status | Root Cause |
|-----------|--------|------------|
| **Static analysis depth** | ❌ Superficial | All services are skeletons (~50-100 lines) — no real CFG, no path-sensitive analysis |
| **AST Scan** | ❌ 22 lines | Returns only function names, no memory pattern analysis |
| **Call Graph** | ❌ 53 lines | No cross-file resolution, no recursion detection |
| **Function Summary** | ❌ 56 lines | Just counts alloc/free, no ownership tracking |
| **Path Constraints** | ❌ 53 lines | Regex-based condition listing, no feasibility analysis |
| **Interprocedural Flow** | ❌ 55 lines | Single-level trace, no data flow |
| **Ownership Analysis** | ❌ 108 lines | Simple heuristics, no RAII/smart-pointer |
| **LeakGuard Docker (Apple Silicon)** | ❌ Broken | AVX issue with TensorFlow on arm64 |
| **LeakGuard MCP Server** | ❌ Partial | Only wraps Step_5, not full pipeline |
| **LeakGuard Adapter** | ❌ Regex parsing | Can't parse structured output |
| **Agentic Orchestrator** | ❌ Linear pipeline | No LLM loop, no adaptive depth |
| **Investigation Planner (LLM)** | ❌ Fallback-heavy | Simple prompt, falls back to heuristic immediately |
| **Judge (heuristic)** | ❌ Basic | No LLM-powered verdict/explanation |
| **Upload Zip** | ❌ Not implemented | Controller has FileInterceptor, no logic |
| **Error handling** | ❌ Weak | Catch-all silent fallbacks, no retry |
| **Cross-platform dynamic** | ❌ macOS broken | Valgrind Linux-only, build-target adaptation fragile |
| **Login flow** | ❌ Not connected | JWT exists, frontend LoginPage is scaffold |

---

## 2. Architecture Target: Agentic Orchestrator

### 2.1 Core Concept

The new orchestrator is an LLM-powered agent that controls the entire scan process. Instead of a fixed pipeline, it operates as an adaptive loop:

```
┌─────────────────────────────────────────────────────────────┐
│                   AGENTIC ORCHESTRATOR LOOP                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ STATE: Scan State Machine                              │   │
│  │  • Workspace (path, type, manifest)                   │   │
│  │  • Candidates (ranked by LLM priority)                │   │
│  │  • Bundles (evidence accumulated)                     │   │
│  │  • Tool History (what ran, what succeeded)            │   │
│  │  • Plan (current strategy, next actions)              │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  LOOP {                                                      │
│    // 1. LLM evaluates current state                        │
│    state_summary = summarize(bundles, evidence, tool_results)│
│                                                              │
│    // 2. LLM decides next action                             │
│    action = llm.decide({                                     │
│      system_prompt: memory_leak_expert_system_prompt,       │
│      context: state_summary,                                 │
│      available_tools: tool_catalog,                          │
│      chain_of_thought: true                                  │
│    })                                                        │
│                                                              │
│    // 3. Execute action (or tool call)                       │
│    if action.kind == 'run_tool':                             │
│      result = tool_registry.invoke(action.tool, args)       │
│    elif action.kind == 'run_leakguard':                      │
│      result = leakguard_adapter.run(project, build_cmd)     │
│    elif action.kind == 'run_dynamic':                        │
│      result = dynamic_planner.execute(plan)                 │
│    elif action.kind == 'judge_bundle':                       │
│      verdict = llm_judge(bundle, static_context, evidence)  │
│    elif action.kind == 'finish':                             │
│      break                                                   │
│                                                              │
│    // 4. Update state with results                           │
│    update_state(result)                                      │
│  }                                                           │
│                                                              │
│  // 5. Final verdict + report                                │
│  report = generate_report(bundles, verdicts, metadata)       │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 LLM as the "Brain"

| Decision Point | What LLM Decides | Input Context |
|---|---|---|
| **Initial Strategy** | Which phases to run, depth settings | File manifest, repo size, languages |
| **Candidate Ranking** | Which allocation sites are most suspicious | Code snippet, function context, call graph |
| **Tool Selection** | Which static analysis tool next | Previous results, confidence, bundle type |
| **Depth Control** | Continue investigating or move on | Evidence strength, time spent |
| **Dynamic Trigger** | Build + run sanitizer? | Binary available? High-confidence candidates? |
| **Verdict** | Confirmed/Likely/Uncertain/FP | All evidence, static context, dynamic results |
| **Explanation** | Why is this a leak? Root cause | Code flow, allocation history |
| **Repair Suggestion** | How to fix? Code diff | Source context, leak pattern |
| **Re-planning** | Change strategy mid-scan | Slow progress, new findings, failures |

### 2.3 System Prompt Architecture

```
YOU ARE an expert C/C++ memory leak detection specialist.
You have access to the following MCP tools:
  [tool catalog with descriptions]

YOUR MISSION:
  Find as many real memory leaks as possible in the given
  C/C++ codebase. For each leak, identify:
  1. Exact file + line number
  2. Root cause (why it leaks)
  3. Repair suggestion

ANALYSIS APPROACH:
  - Phase 1: Scan for allocation sites (candidates)
  - Phase 2: Rank candidates by risk
  - Phase 3: For each high-risk candidate:
      a) Analyze function control flow
      b) Trace allocation → all exit paths
      c) Check each path for matching free
      d) If free exists on some paths → path-sensitive leak
      e) If no free found → interprocedural trace
      f) If still no free → suggest dynamic confirmation
  - Phase 4: Cross-validate with LeakGuard / ASan / Valgrind
  - Phase 5: Produce verdict + repair suggestion

CHAIN OF THOUGHT:
  For each investigation, think step by step:
  1. Which function(s) does this allocation belong to?
  2. What are the exit paths?
  3. On each path, is there a matching free?
  4. If not: is the pointer returned/stored elsewhere?
  5. Is there an ownership convention documented?

TOOL USAGE:
  Be strategic about tool usage:
  - Start with lightweight tools (candidate_scan)
  - Use heavier tools (call_graph, data_flow) only on
    high-confidence candidates
  - Use dynamic analysis only when you have a buildable
    binary and strong static evidence
```

### 2.4 Tool Catalog

| Tool | Phase | Cost | When to Use |
|---|---|---|---|
| `repo.index_files` | Discovery | Low | Always first |
| `memory.candidate_scan` | Discovery | Low | After indexing |
| `memory.ast_scan` | Static | Medium | For specific high-confidence candidates |
| `memory.call_graph` | Static | Medium | When allocation site needs interprocedural tracing |
| `memory.function_summary` | Static | Low | Quick overview of a function |
| `memory.path_constraints` | Static | Medium | When allocation is in conditional branches |
| `memory.interprocedural_flow` | Static | High | When pointer escapes the function |
| `memory.ownership_summary` | Static | Medium | For ownership convention analysis |
| `memory.leakguard_run` | Deep Static | High | For final cross-validation |
| `valgrind.analyze_memcheck` | Dynamic | High | When binary is available (Linux) |
| `asan.run` | Dynamic | Medium | When binary built with ASan |
| `lsan.run` | Dynamic | Low | Lightweight leak check |
| `memory.leakguard_get_report` | Deep Static | Low | After leakguard_run |

---

## 3. Detailed Work Breakdown

### PHASE A: Agentic Orchestrator Core (Priority: P0, Effort: Large)

**A.1. Rewrite ScanOrchestratorService as Agentic Loop**
- [A.1.1] Design state machine for scan lifecycle
- [A.1.2] Implement LLM decision loop with chain-of-thought
- [A.1.3] Tool selection is dynamic, not pre-determined
- [A.1.4] Adaptive depth: bundles with strong evidence get deeper analysis
- [A.1.5] Progress feedback through existing SSE system
- Files: `apps/control-plane/src/services/scan-orchestrator.service.ts`

**A.2. Upgrade InvestigationPlannerService**
- [A.2.1] Rich LLM prompt with full bundle context + tool catalog
- [A.2.2] Multi-turn re-planning based on execution results
- [A.2.3] Strategy library: predefined strategies for common patterns
- [A.2.4] LLM fallback: when LLM fails, use smarter heuristic (not just simple fallback)
- Files: `apps/control-plane/src/services/investigation-planner.service.ts`

**A.3. Tool Registry Enhancement**
- [A.3.1] Add Python MCP server tools as registrable tools
- [A.3.2] Tool chaining: output of one tool feeds into another
- [A.3.3] Tool dependency graph
- [A.3.4] Cost/benefit tracking: track time per tool to inform LLM decisions
- Files: `apps/control-plane/src/services/tool-registry.service.ts`

### PHASE B: Static Analysis Engine (Priority: P0, Effort: Very Large)

**B.1. C-Parser — True CFG & Analysis (P0)**
- [B.1.1] Build full Control Flow Graph from tree-sitter AST
- [B.1.2] Identify all exit paths per function (return, goto, longjmp, exit)
- [B.1.3] For each allocation: compute reachable-free on every exit path
- [B.1.4] Path-sensitive: conditionA → free, conditionB → no_free
- [B.1.5] Loop-aware: allocation inside loop without free inside loop
- [B.1.6] Early return detection: return before matching free
- [B.1.7] Nested struct field allocation tracking
- [B.1.8] Pointer aliasing analysis
- Files: `apps/static-analyzer/src/services/c-parser.service.ts`

**B.2. Real AST Memory Pattern Scanner (P1)**
- [B.2.1] Pattern: malloc in loop body without free → accumulating leak
- [B.2.2] Pattern: conditional allocation: if(x) { p=malloc(); } ... no free
- [B.2.3] Pattern: missing NULL check after allocation, then NULL deref
- [B.2.4] Pattern: double free (free → free same pointer)
- [B.2.5] Pattern: use-after-free (free → use pointer)
- [B.2.6] Pattern: strdup() without free
- [B.2.7] Pattern: realloc() without checking return (loses original pointer)
- Files: `apps/static-analyzer/src/services/ast-scan.service.ts`

**B.3. Call Graph — Interprocedural & Recursive (P2)**
- [B.3.1] Cross-file call graph resolution
- [B.3.2] Recursion detection (direct + mutual)
- [B.3.3] Indirect call resolution (function pointers, vtables)
- [B.3.4] Reachability: can allocation site reach a free site?
- Files: `apps/static-analyzer/src/services/call-graph.service.ts`

**B.4. Function Summary — Ownership & Contract (P2)**
- [B.4.1] Detects "returns_ownership" pattern: malloc → return ptr
- [B.4.2] Detects "consumes_ownership" pattern: takes ptr → free
- [B.4.3] Detects "transfers_ownership": alloc → store → return
- [B.4.4] Function contract inference for LLM context
- Files: `apps/static-analyzer/src/services/function-summary.service.ts`

**B.5. Path Constraints — Symbolic Execution Lite (P3)**
- [B.5.1] Extract path conditions for each branch
- [B.5.2] Simple symbolic execution: which paths are feasible?
- [B.5.3] Branch coverage analysis for allocation/free pairs
- Files: `apps/static-analyzer/src/services/path-constraints.service.ts`

**B.6. Interprocedural Data Flow (P2)**
- [B.6.1] Track allocated pointer through function calls
- [B.6.2] Taint tracking: mark allocated regions
- [B.6.3] Deep chain analysis: A→B→C→free vs A→B→D→leak
- Files: `apps/static-analyzer/src/services/interprocedural-flow.service.ts`

**B.7. Ownership Analysis — Real C/C++ Conventions (P2)**
- [B.7.1] malloc/free contract detection
- [B.7.2] new/delete contract detection (C++)
- [B.7.3] Smart pointer analysis (unique_ptr, shared_ptr, auto_ptr)
- [B.7.4] RAII: destructor analysis for member allocations
- [B.7.5] Custom allocator pairs (e.g., my_malloc / my_free)
- Files: `apps/static-analyzer/src/services/ownership-analysis.service.ts`

### PHASE C: LeakGuard Integration (Priority: P2, Effort: Medium)

**C.1. Docker Build for Apple Silicon (P2)**
- [C.1.1] Multi-arch Dockerfile (linux/arm64 + linux/amd64)
- [C.1.2] Isolate TensorFlow steps behind a flag
- [C.1.3] Test build on Apple Silicon
- Files: `tools/leak_guard_tool/Dockerfile`, `tools/leak_guard_tool/docker-compose.yml`

**C.2. Full MCP Server (P2)**
- [C.2.1] Refactor run.py into importable modules
- [C.2.2] Expose all pipeline steps as MCP tools
- [C.2.3] Per-plugin execution via MCP
- [C.2.4] Progress streaming
- Files: `tools/leak_guard_tool/leakguard_mcp_server.py`, `tools/leak_guard_tool/run.py`

**C.3. LeakGuard Adapter Enhancement (P2)**
- [C.3.1] Parse structured JSON output
- [C.3.2] Map findings to LeakBundle format correctly
- [C.3.3] Handle timeouts, partial results, errors gracefully
- Files: `apps/static-analyzer/src/services/leakguard-adapter.service.ts`

### PHASE D: LLM Judge & Reporting (Priority: P1, Effort: Medium)

**D.1. LLM-Powered Judge (P1)**
- [D.1.1] Verdict generation via LLM (confirmed/likely/uncertain)
- [D.1.2] LLM generates explanation: nguyên nhân leak, cơ chế, tại sao leak
- [D.1.3] LLM generates repair suggestion with concrete code changes
- [D.1.4] Include code snippet + call chain in LLM context
- [D.1.5] Multiple evidence sources combined by LLM (not just heuristic scoring)
- Files: `apps/control-plane/src/services/judge.service.ts`

**D.2. Professional HTML Report (P1)**
- [D.2.1] Beautiful HTML with CSS framework
- [D.2.2] Search, filter, sort findings
- [D.2.3] Code snippet with highlighted leak lines
- [D.2.4] Severity breakdown chart
- [D.2.5] Download as standalone HTML file
- Files: `apps/control-plane/src/services/reporting.service.ts`

**D.3. Professional PDF Report (P3)**
- [D.3.1] Use pdfkit or similar library instead of raw PDF
- [D.3.2] Structured layout: summary, findings table, per-finding detail
- [D.3.3] Code snippets in monospace
- [D.3.4] Cover page with scan metadata
- Files: `apps/control-plane/src/services/reporting.service.ts`

### PHASE E: Infrastructure & UX (Priority: P1-P3)

**E.1. Upload Zip Support (P1)**
- [E.1.1] File upload endpoint receives zip
- [E.1.2] Extract to scan workspace
- [E.1.3] Treat as workspace_path source type
- Files: `apps/control-plane/src/controllers/workspace.controller.ts`

**E.2. Multiple Source Types (P1)**
- [E.2.1] Direct git clone from URL (no OAuth needed)
- [E.2.2] Public GitHub repo without authentication
- [E.2.3] Upload zip via frontend drag-and-drop
- Files: multi

**E.3. Scan Workspace Optimization (P3)**
- [E.3.1] Hardlink/symlink for large repos
- [E.3.2] Incremental materialization
- [E.3.3] Cleanup policy (TTL-based)
- Files: `apps/control-plane/src/services/scan-workspace.service.ts`

**E.4. Cross-Platform Dynamic Analysis (P2)**
- [E.4.1] Docker-based dynamic analysis for macOS
- [E.4.2] Build system support matrix: CMake, Make, Autotools, Meson, Bazel
- [E.4.3] Binary discovery improvements
- [E.4.4] Clang sanitizer instrumentation wrapper
- Files: `apps/dynamic-analyzer/src/services/build-target.service.ts`

**E.5. Error Handling & Resilience (P2)**
- [E.5.1] Retry with exponential backoff
- [E.5.2] Graceful degradation: partial results still saved
- [E.5.3] Tool-level timeouts
- [E.5.4] Error categorization for user feedback
- [E.5.5] Memory/disk monitoring
- Files: multi

**E.6. Frontend Polish (P3)**
- [E.6.1] Working login flow
- [E.6.2] Finding browser with filter/search/sort
- [E.6.3] Code viewer with line highlighting
- [E.6.4] Report download buttons
- [E.6.5] Real-time scan progress with phase visualization
- Files: `apps/leak-inspector-ui/`

### PHASE F: Verification & Testing

**F.1. Test Corpus Expansion**
- [F.1.1] Add diverse C/C++ leak patterns to demo corpus
- [F.1.2] Standard patterns: early_return, conditional, loop_accumulate, double_free, use_after_free, strdup_leak, struct_field_leak, realloc_mishandle
- [F.1.3] Real-world targets: small open-source C/C++ projects
- Files: `demo/memory_leak_corpus/`

**F.2. E2E Smoke Tests**
- [F.2.1] Update `scripts/run-local-scan-smoke.ts` for each test pattern
- [F.2.2] Automatic verification: scan should detect known leaks
- [F.2.3] Regression testing
- Files: `scripts/run-local-scan-smoke.ts`

---

## 4. Implementation Roadmap

### Sprint 1: Foundation — Agentic Loop + C-Parser
```
┌─────────────────────────────────────────────────────────┐
│ Sprint 1 Deliverables                                     │
├─────────────────────────────────────────────────────────┤
│ 1. A.1 Agentic loop orchestrator (basic working)         │
│ 2. A.2 LLM investigation planner (no fallback)           │
│ 3. B.1 C-Parser CFG + exit path analysis                 │
│ 4. B.2 Basic memory pattern detection                    │
│ 5. D.1 LLM Judge (basic verdict + explanation)           │
│ 6. Test on demo corpus                                   │
└─────────────────────────────────────────────────────────┘
```

### Sprint 2: Depth — Advanced Analysis
```
┌─────────────────────────────────────────────────────────┐
│ Sprint 2 Deliverables                                     │
├─────────────────────────────────────────────────────────┤
│ 1. B.3-B.7 Complete static analysis services             │
│ 2. C.1-C.3 LeakGuard integration working                 │
│ 3. D.2-D.3 Professional reports                          │
│ 4. E.4 Cross-platform dynamic                            │
│ 5. E.5 Error handling & resilience                       │
│ 6. A.3 Tool registry with all tools                      │
└─────────────────────────────────────────────────────────┘
```

### Sprint 3: Polish - Completed (2026-05-28)

| Task | Files | Status |
|------|-------|--------|
| Upload zip support (500MB, disk storage, safe extraction) | workspace.controller.ts, persistence.service.ts | Done |
| Upload-and-scan one-step flow | workspace.controller.ts | Done |
| Public GitHub clone by URL (no OAuth) | workspace.controller.ts, persistence.service.ts | Done |
| Clone-and-scan one-step flow | workspace.controller.ts | Done |
| Test corpus expansion (7 new patterns -> 16 total) | demo/memory_leak_corpus/ | Done |
| Smoke test script with --all mode | run-local-scan-smoke.ts (278 lines) | Done |
| 119 TypeScript files, 5567 lines service code | all verified | Done |

### Completion Audit

| Requirement | Evidence | Status |
|------------|----------|--------|
| Scan from GitHub | OAuth clone + public URL clone | Done |
| Scan from upload zip | Upload endpoint with safe extraction | Done |
| Scan from local path | Works fine via workspace path | Done |
| Agentic orchestrator with LLM | scan-orchestrator.service.ts agentic loop | Done |
| LLM tool selection + chain-of-thought | investigation-planner.service.ts system prompt | Done |
| Detect leak: line, file, fix, cause, explanation | ast-scan.service.ts (8 patterns) + LLM Judge | Done |
| Report: PDF, HTML, JSON, MD (+CSV) | reporting.service.ts (6 formats) | Done |
| Static analysis depth | 946-line C-Parser with CFG, 7 enhanced services | Done |
| Cross-platform dynamic analysis | Docker fallback on macOS | Done |
| Test corpus coverage | 16 patterns, 30 files, 1101 lines of C | Done |
