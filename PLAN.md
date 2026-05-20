Thesis/PLAN.md#L1-500
# PLAN.md — LLM-Orchestrated Memory Leak Investigation
## Master's Thesis Development Roadmap

> **Last updated:** 2026-05-17  
> **Status:** ~95% implementation complete — evaluation and thesis-quality hardening in progress

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Analysis](#2-current-state-analysis)
3. [Issues & Technical Debt](#3-issues--technical-debt)
4. [Improvement Opportunities](#4-improvement-opportunities)
5. [Phase-by-Phase Plan](#5-phase-by-phase-plan)
6. [Success Metrics](#6-success-metrics)
7. [Risk Assessment](#7-risk-assessment)
8. [Appendix — File Map](#8-appendix--file-map)

---

## 1. Executive Summary

This project builds a system for **LLM-orchestrated memory leak investigation** in C/C++ repositories. The central thesis contribution is demonstrating that a multi-agent pipeline — combining lightweight static analysis, project-level static analysis (LeakGuard/Clang SA), runtime dynamic analysis (Valgrind/ASan/LSan), and an LLM judge — detects more real leaks with fewer false positives than any single-tool approach.

### Current Implementation Status

| Component | Status | Notes |
|---|---|---|
| Static MCP server (13 tools) | ✅ Implemented | tree-sitter AST, regex lexical, LeakGuard Docker |
| Dynamic MCP server (12 tools) | ✅ Implemented | Valgrind, ASan, LSan, artifact store |
| Control plane (MCP-Vul) | ✅ Implemented | 10-phase pipeline, SSE progress |
| Shared schema (mcp-memory-common) | ✅ Implemented | Pydantic v2, all models |
| Heuristic judge | ✅ Implemented | Rule-based, deterministic |
| LLM judge | ✅ Implemented | Anthropic/OpenAI, single-turn batch |
| Web UI | ✅ Implemented | React 19 + Vite + DaisyUI + @xyflow |
| Test corpus | ⚠️ Partial | `simple_leak` is **empty** — only 1 of 2 cases usable |
| End-to-end evaluation | ❌ Not started | Blocking thesis results chapter |
| Cross-file static analysis | ❌ Not implemented | All tools are intra-file only |
| Multi-turn LLM orchestration | ❌ Not implemented | Single-turn only |

### What Remains for Thesis-Quality Evaluation

1. **Fix `simple_leak`** and expand corpus to ≥8 labeled cases
2. **Run baseline** (static-only) vs **orchestrated** (static + dynamic + LLM) → record precision/recall
3. **Ablation study**: static-only → +LeakGuard → +Valgrind → +LLM judge
4. **Judge comparison**: LLM judge vs heuristic judge on same corpus
5. **Address critical structural issues** (sys.path hacks, O(n²) dedup) before scaling corpus

---

## 2. Current State Analysis

### 2.1 What Is Working Well

- **10-phase scan pipeline** correctly sequences index → lexical scan → per-file static expansion → project-level LeakGuard → dynamic build/execute → bundle merge → judge → report
- **Adaptive investigation policy** selects tool sets based on `minimal`/`balanced`/`full` expansion modes
- **Candidate clustering** merges bundles from multiple tools by file path, allocation line, function identity, and token overlap
- **Dual-mode judge**: `HeuristicMemoryLeakJudge` (deterministic) + `MemoryLeakJudge` (LLM with fallback)
- **Four report formats**: JSON, Markdown, HTML, snapshot — all generated and tested
- **Web app** has full scan lifecycle: workspace selection → launch → SSE progress stream → report viewer
- **Docker Compose** stacks for all three services plus full-demo stack
- **Unit tests** for judge, control plane, batch runner, reporting, app layer

### 2.2 Critical Gaps Blocking Thesis Evaluation

| Gap | Impact |
|---|---|
| `simple_leak` corpus case is empty (no `.c` files) | 50% of corpus unusable; batch runner silently skips |
| Only 2 corpus cases total | Cannot compute statistically meaningful precision/recall |
| No ground-truth scoring automation | Cannot automatically compute TP/FP/FN from report output |
| Intra-file-only static analysis | Cross-function leaks in multi-file projects are missed |
| LLM judge is single-turn | Cannot self-correct or request additional evidence |
| No ablation experiment driver | Comparing modes requires manual re-runs and diffs |
| sys.path hack fragile in Docker | May silently fail in clean build environments |

---

## 3. Issues & Technical Debt

### 3.1 Critical (Blocking Thesis Evaluation)

| ID | Issue | Location | Effect |
|---|---|---|---|
| **C-01** | `simple_leak` corpus case is **empty** — no `.c` files | `demo/memory_leak_corpus/simple_leak/` | Batch runner returns no results for 1 of 2 cases |
| **C-02** | **Corpus too small** — only 2 cases, 1 unusable | `corpus_manifest.json` | Precision/recall numbers are statistically meaningless |
| **C-03** | **No ground-truth scoring CLI** | `batch_runner.py` | Cannot automatically compute TP/FP/FN from reports |
| **C-04** | **sys.path hack** — both `shared_schema.py` files dynamically inject `mcp-memory-common/src` at import time | `MCP-Vul/src/memory_leak/shared_schema.py`, `mcp-dynamic-analysis-server/src/.../core/shared_schema.py` | Fragile in Docker multi-stage builds |

### 3.2 High Priority

| ID | Issue | Location | Effect |
|---|---|---|---|
| **H-01** | **O(n²) bundle deduplication** — `_find_similar_bundle` does linear scan | `candidate_manager.py` | Quadratic scan time with 100+ candidates |
| **H-02** | **No official MCP Python SDK** — manual JSON-RPC 2.0 over stdlib `http.server` | Both `http_server.py` files | Protocol drift risk; duplicated boilerplate |
| **H-03** | **Intra-file-only static analysis** — all expansion tools work within a single file | All static tools | Cross-translation-unit leaks never detected |
| **H-04** | **No retry/circuit-breaker** for MCP tool calls | `mcp_protocol/client.py` | Single timeout aborts entire scan |
| **H-05** | **No end-to-end integration tests** | `MCP-Vul/tests/` | Pipeline breaks invisible without E2E tests |
| **H-06** | **No ablation experiment driver** | `batch_runner.py` | Cannot automate static-only vs. orchestrated comparison |

### 3.3 Medium Priority

| ID | Issue | Location | Effect |
|---|---|---|---|
| **M-01** | **High FP rate in `candidate_scan`** — pure regex, no scope awareness | `tools/candidate_scan.py` | Inflates investigation cost; misleads judge |
| **M-02** | **Heuristic dynamic target discovery** — filesystem ELF scan, no CMake/Make integration | `dynamic_orchestration.py` | Picks up test binaries; misses declared targets |
| **M-03** | **Single-turn LLM judge** — no refinement loop | `judge.py` | Cannot request clarification or extra evidence |
| **M-04** | **Hardcoded LLM prompts** — not configurable, not version-tracked | `judge.py` | Prompt experiments require code changes |
| **M-05** | **No token budget management** — large bundles sent unsized | `judge.py` | Silent truncation by LLM API possible |
| **M-06** | **stdlib `ThreadingHTTPServer`** for all three HTTP services | `http_server.py` (both), `server.py` | No async I/O; limited under concurrent load |
| **M-07** | **Docker-in-Docker LeakGuard** — complex path translation | `leakguard_run.py` | Brittle on non-standard Docker setups |

### 3.4 Nice-to-Have / Future Work

| ID | Issue |
|---|---|
| N-01 | No hot-reload for analysis servers (only MCP-Vul has `dev.sh` + watchdog) |
| N-02 | No streaming LLM responses — judge waits for full completion |
| N-03 | No taint analysis — pointer aliasing, struct field leaks invisible |
| N-04 | `uv.lock` at root but individual components use separate `venv`s |
| N-05 | No remote analyzer cancellation propagation |
| N-06 | No UI tests for scan lifecycle and report rendering |

---

## 4. Improvement Opportunities

### 4.1 Analysis Quality

| Opportunity | Approach | Expected Gain |
|---|---|---|
| **Cross-file call graph** | Build project-level symbol table via tree-sitter over all indexed files; resolve cross-file callees | Detect leaks spanning translation units |
| **AST gate for `candidate_scan`** | After regex match, verify allocation is inside a `function_definition` AST node, not a comment | Reduce FP rate ~30–40% |
| **CMake/Makefile target parsing** | Parse `add_executable()` from `CMakeLists.txt` and link targets from `Makefile` | More precise dynamic binary list |
| **tree-sitter query API** | Replace manual tree-walking in `_parser.py` with S-expression queries (tree-sitter 0.23+) | More maintainable AST analysis |

### 4.2 LLM / Judge

| Opportunity | Approach | Expected Gain |
|---|---|---|
| **Multi-turn LLM judge** | After initial verdict, allow LLM to request one additional static tool result, then re-evaluate | Lower FP rate on ambiguous cases |
| **Prompt versioning** | Store prompts as YAML files in `prompts/`; load at runtime by version | Easy A/B testing; reproducible experiments |
| **Token budget management** | Estimate tokens before sending; truncate low-priority evidence; never drop dynamic findings | Prevent silent API truncation |
| **LLM-driven tool selection** | Replace `InvestigationPolicy` rule table with an LLM planner (optional mode) | More targeted evidence gathering |

### 4.3 Infrastructure

| Opportunity | Approach | Expected Gain |
|---|---|---|
| **Official MCP SDK** | `mcp>=1.0.0` already in MCP-Vul deps — use `FastMCP` for both servers | Protocol correctness; less boilerplate |
| **Proper `mcp-memory-common` install** | Add as `[tool.uv.sources]` local dep; remove sys.path hacks | Reliable imports in any environment |
| **FastAPI for web app** | Replace stdlib `ThreadingHTTPServer` with FastAPI + uvicorn | Async I/O; automatic `/docs` |
| **OpenTelemetry tracing** | Propagate `traceparent` across MCP HTTP calls | End-to-end latency visibility |
| **Structured logging** | `structlog` in all components; JSON in Docker, colored in dev | Machine-parseable logs |

---

## 5. Phase-by-Phase Plan

---

### Phase 0 — Corpus & Baseline (Week 1–2) — 🔴 URGENT

**Goal:** Fix broken corpus case, expand to ≥8 labeled cases, run first end-to-end evaluation, document baseline numbers.

**Why Phase 0:** Without a working corpus, no subsequent improvement can be measured.

#### P0.1 — Fix `simple_leak` (resolves C-01)

Create `demo/memory_leak_corpus/simple_leak/` with:

```
simple_leak/
├── Makefile          ← make CC=clang produces ELF binary
├── make_buffer.h     ← declares char* make_buffer(size_t n)
├── make_buffer.c     ← malloc()s a buffer, returns pointer (never freed)
└── main.c            ← calls make_buffer(), never frees, exits
```

Split across two files to also exercise cross-file detection. Verify: `make CC=clang` succeeds; Valgrind reports exactly **1 definite leak**.

#### P0.2 — Add 6–8 New Corpus Cases (resolves C-02)

Each case needs: `Makefile`, compilable C/C++ source, `corpus_manifest.json` entry with `expected_leak_count`.

| Case ID | Pattern | Expected Leaks |
|---|---|---|
| `early_return_leak` | `malloc` → conditional early return without `free` | 2 |
| `realloc_lose_pointer` | `p = realloc(p, n)` without NULL check → original `p` lost | 1 |
| `loop_accumulate` | Allocate in loop, pointer overwritten each iteration | 5 |
| `struct_partial_free` | `free(struct)` but forget to free nested pointer field | 3 |
| `ownership_transfer` | Function allocates and returns; caller never frees | 2 |
| `exception_path_cpp` | C++ `new` + early `throw` without `delete` | 1 |
| `global_unreferenced` | `malloc` to global, never freed at exit | 1 |
| `list_cleanup_partial` | Linked list `free` loop skips tail node | 1 |

> Real-world-inspired cases (redis, CPython, nginx) are academically stronger — cite source commit SHA in `notes` field.

#### P0.3 — Implement Ground-Truth Scoring CLI (resolves C-03)

Add `mcp-vul-memory-score` entry point that:
1. Loads `corpus_manifest.json`
2. For each case, loads `results/corpus/<id>/snapshot.json`
3. Counts: `confirmed_leak` + `likely_leak` = predicted positive
4. Computes TP/FP/FN against `expected_leak_count`
5. Outputs `results/corpus/evaluation_summary.json`

Output schema:
```json
{
  "schema_version": "memory-leak-eval/v1",
  "judge_mode": "heuristic",
  "static_expansion_mode": "balanced",
  "cases": [{
    "id": "simple_leak",
    "expected_leak_count": 1,
    "tp": 1, "fp": 0, "fn": 0,
    "precision": 1.0, "recall": 1.0, "f1": 1.0
  }],
  "aggregate": {
    "macro_precision": 0.80,
    "macro_recall": 0.80,
    "macro_f1": 0.80
  }
}
```

> **Counting convention:** One unique allocation call site = one leak. Document in manifest.

#### P0.4 — Run and Document Baselines

Before any Phase 1+ changes, run two configurations:
1. `minimal` mode + no dynamic + heuristic → `results/baselines/static_lexical_only/`
2. `balanced` mode + dynamic + heuristic → `results/baselines/orchestrated_heuristic/`

Write `results/baselines/README.md` with precision/recall table → becomes thesis Section 5.2.

**Phase 0 Acceptance Criteria:**
- [ ] `corpus_manifest.json` has ≥8 entries
- [ ] All corpus directories contain compilable C/C++ + Makefile
- [ ] `make CC=clang` succeeds for every case
- [ ] `run_memory_leak_corpus.sh` completes without errors
- [ ] `mcp-vul-memory-score` produces `evaluation_summary.json`
- [ ] `results/baselines/README.md` has precision/recall table

**Estimated effort:** 3–4 days

---

### Phase 1 — Foundation Hardening (Week 2–3)

**Goal:** Eliminate fragile structural issues before scaling evaluation. No new features.

#### P1.1 — Fix sys.path Hacks (resolves C-04)

Replace runtime `sys.path.insert` in both `shared_schema.py` files with proper pip dependency:

```toml
# pyproject.toml for each server
[tool.uv.sources]
mcp-memory-common = { path = "../mcp-memory-common", editable = true }
```

Dockerfile update:
```dockerfile
COPY mcp-memory-common /workspace/mcp-memory-common
RUN pip install -e /workspace/mcp-memory-common
```

Delete: `_ensure_common_schema_importable()`, `ensure_shared_schema_import_path()`, and all `sys.path.insert` calls.

**Criteria:** `python -c "from mcp_memory_common import LeakBundle"` works inside each Docker container.

#### P1.2 — Fix O(n²) Bundle Deduplication (resolves H-01)

Add two index dicts to `CandidateManager`:
```python
self._index_by_file_line: dict[tuple[str, int], list[LeakBundle]] = {}
# key: (filename_stem, allocation_line // 5)  — 5-line window buckets
self._index_by_function: dict[str, list[LeakBundle]] = {}
```

Rewrite `_find_similar_bundle` to look up only relevant buckets. Add 200-bundle stress test (must complete in <200ms).

#### P1.3 — Add MCP Tool-Call Retry (resolves H-04)

Add `_retry_tool_call(tool_name, params, max_attempts=3, backoff_sec=1.0)`:
- Retry: `ConnectionError`, `TimeoutError`, JSON-RPC `-32603`
- Never retry: `-32602 Invalid params`, `-32601 Method not found`
- Non-required tool failure: log warning, continue scan
- Required tool failure: abort with clear error

#### P1.4 — Corpus-Based Integration Test Harness (resolves H-05)

Add `MCP-Vul/tests/test_corpus_integration.py` with:
- `@pytest.mark.integration` marker
- Parametrized over corpus cases
- Asserts `recall >= 0.5` (loose — just catches complete breakage)
- Runs against real corpus directories with mock MCP servers

**Estimated effort:** 2–3 days

---

### Phase 2 — Analysis Quality (Week 3–5)

**Goal:** Improve detection rate by addressing core analysis gaps.

#### P2.1 — Cross-File Static Analysis via Project Symbol Table (resolves H-03)

**New tool `memory.project_symbol_table`:**
- Input: list of `{file_path, source_code}` objects
- tree-sitter extracts: function signatures, return types, allocation/free calls, callers/callees
- Returns cross-file JSON symbol table

**Updated tools:**
- `memory.interprocedural_flow` + `memory.call_graph` accept optional `project_symbol_table`
- When provided, callee resolution crosses file boundaries

**Acceptance criteria:**
- [ ] Two-file mock project (allocator in `a.c`, caller in `b.c`) — cross-file leak detected
- [ ] `complex_leak_lab` shows ≥1 additional leak vs. baseline

#### P2.2 — CMakeLists.txt / Makefile Target Parsing (resolves M-02)

Add `_parse_build_system_targets(repo_root)` to `dynamic_orchestration.py`:
- Parse `add_executable(<name> ...)` from `CMakeLists.txt`
- Parse link targets from `Makefile` (`$(CC)`/`$(CXX)` lines)
- Fall back to ELF magic scan if no build system files found

#### P2.3 — AST Gate for `candidate_scan` FP Reduction (resolves M-01)

After regex match, use tree-sitter to verify allocation is inside `function_definition` AST node (not comment, not global scope). Add `confidence: "high"|"low"` field. Only trigger full static expansion for `"high"` confidence candidates.

#### P2.4 — Schema Normalization for Static Tools

Add `_to_schema_format()` adapters for each static tool's raw output. Update `candidate_manager.py` to use `LeakEvidence.model_validate(...)`.

**Estimated effort:** 4–5 days

---

### Phase 3 — LLM Orchestration Enhancement (Week 5–7)

**Goal:** Advance LLM judge from single-turn to multi-turn agentic loop — the core thesis novelty.

#### P3.1 — Multi-Turn LLM Judge (resolves M-03) — Core Thesis Contribution

**Agentic loop design:**
```
for bundle where verdict == "inconclusive" or confidence == "low":
    turn_1: send bundle evidence + available tools to LLM
    → LLM responds with:
        a) final verdict → DONE
        b) tool_request {"tool": "...", "file": "...", "function": "..."}
    if tool_request and turns < MAX_TURNS:
        call static tool via MCP
        append result as new LeakEvidence
        turn_N+1: re-evaluate → repeat
    if MAX_TURNS exhausted → fall back to HeuristicMemoryLeakJudge
```

**Implementation:**
1. Add `_judge_with_llm_multiturn(bundle, mcp_client, max_turns=3)` to `judge.py`
2. Extend system prompt to include `tool_request` as valid response format
3. Add `MultiturnJudgeTrace` Pydantic model (turns, tools called, evidence added)
4. Control via `MEMORY_LEAK_JUDGE_MAX_TURNS` env var (default: `1` for backward compat)

**Acceptance criteria:**
- [ ] `MAX_TURNS=3` triggers tool calls for inconclusive bundles
- [ ] `judge_traces` key in scan report JSON
- [ ] `MAX_TURNS=1` reproduces existing single-turn behavior exactly
- [ ] ≥1 corpus case shows recall improvement with `max_turns=3`

#### P3.2 — Prompt Versioning (resolves M-04)

Create `MCP-Vul/src/memory_leak/prompts/` with YAML files:
- `judge_single_turn_v1.yaml`
- `judge_batch_v1.yaml`
- `judge_multiturn_v1.yaml`

Fields: `version`, `description`, `system_prompt`, `user_prompt_template`. Add `MEMORY_LEAK_JUDGE_PROMPT_VERSION` env var. Log active version; include in report metadata.

#### P3.3 — Token Budget Management (resolves M-05)

Add `_estimate_tokens(text) -> int` utility (fast: `len(text) // 4`; use `tiktoken` if available). If estimated tokens > `MAX_BUNDLE_PROMPT_TOKENS` (default 6000), drop evidence in order: lexical duplicates → ast_scan details → interprocedural_flow summary. Never drop: dynamic findings, LeakGuard findings. Add `truncated_evidence_count` to verdict metadata.

#### P3.4 — LLM-Driven Adaptive Tool Selection (optional)

After `candidate_scan`, ask LLM: "Which tools from {available} would be most useful for these candidates?" Use LLM's list as expansion decisions. `MEMORY_LEAK_POLICY_MODE=llm|heuristic` (default: `heuristic`).

**Estimated effort:** 4–5 days

---

### Phase 4 — Infrastructure & Scalability (Week 7–8) — Optional

**Goal:** Replace stdlib HTTP with async frameworks; adopt official MCP SDK; add observability.

> Phase 4 is **optional** if Phase 5 (evaluation) is time-constrained. The system works without these changes.

#### P4.1 — Adopt Official MCP Python SDK (resolves H-02)

For each analysis server:
1. Add `mcp>=1.0.0` to `pyproject.toml`
2. Replace `MCPHTTPHandler` with `mcp.server.fastmcp.FastMCP`
3. Register tools via `@mcp_app.tool(name="memory.candidate_scan")` decorator
4. Remove manual `app.py` dispatch and `http_server.py`

#### P4.2 — FastAPI Web App (resolves M-06)

Add `fastapi>=0.115.0` + `uvicorn[standard]>=0.34.0`. Rewrite `server.py` with `APIRouter`. Use `StreamingResponse` for SSE. Enable `/docs` OpenAPI UI.

#### P4.3 — OpenTelemetry Tracing

Add `opentelemetry-sdk` to all components. Trace spans: each MCP tool call (client + server), each scan phase. Propagate `traceparent` via HTTP headers. Console export when `OTEL_EXPORTER_OTLP_ENDPOINT` unset.

#### P4.4 — Structured Logging

Add `structlog>=24.0`. JSON output in Docker; colored console in dev. Bind `bundle_id`, `tool_name`, `scan_id` as context vars.

**Estimated effort:** 3–4 days

---

### Phase 5 — Evaluation & Thesis Writing (Week 8–10)

**Goal:** Full evaluation, ablation study, publication-quality results, thesis writing.

#### P5.1 — Ablation Study Automation (resolves H-06)

Four experiment configurations:

| Mode | Config | Hypothesis |
|---|---|---|
| `static_lexical_only` | `candidate_scan` only, no expansion, no dynamic, heuristic | Highest recall, highest FP |
| `static_full` | All static tools, `balanced`, no dynamic, heuristic | Better precision, moderate recall |
| `static_plus_dynamic` | Full static + Valgrind/ASan, heuristic | Best recall for runtime-confirmed leaks |
| `orchestrated_llm` | Full static + dynamic + LLM judge (`max_turns=3`) | Best precision at moderate recall |

Add `AblationRunner` to `batch_runner.py`. Add `mcp-vul-memory-ablation` CLI. Output `results/ablation/comparison_table.json`.

#### P5.2 — LaTeX/Markdown Output for Snapshot Comparison

Add `--format markdown|latex|json` to `mcp-vul-memory-compare`. Multi-snapshot mode: `mcp-vul-memory-compare results/ablation/*/snapshot.json`. Produces LaTeX `tabular` environment for direct thesis inclusion.

#### P5.3 — LLM Judge Quality Analysis

Run corpus with `judge_mode=heuristic` and `judge_mode=llm` (both `max_turns=1`). Extract verdict disagreements. Categorize: LLM wins / heuristic wins / both wrong / both right. Write `results/judge_comparison/disagreement_analysis.json` + `README.md`.

#### P5.4 — Fix Suggestion Quality Evaluation

Write `demo/memory_leak_corpus/ground_truth_fixes.json` with correct fix for each corpus case. Score each suggestion:
- **Correctness** (0/1): Points to right location and action?
- **Specificity** (1–3): File+line concrete fix (3) vs vague advice (1)
- **Actionability** (1–3): Applicable without further analysis?

#### P5.5 — Thesis Writing Support

| Chapter | Source Material |
|---|---|
| Ch. 3 Related Work | Compare against `Research_on_Automated_Memory_Leak_Detection_Method_Based_on_Cross.pdf` |
| Ch. 4 System Design | `ARCHITECTURE.md` diagrams, tool invocation traces |
| Ch. 5.1 Evaluation Setup | Corpus manifest, counting convention |
| Ch. 5.2 Baseline Results | `results/baselines/README.md` |
| Ch. 5.3 Ablation Study | `results/ablation/comparison_table.json` |
| Ch. 5.4 Judge Comparison | `results/judge_comparison/README.md` |
| Ch. 5.5 Fix Suggestions | `results/fix_quality/README.md` |
| Ch. 6 Discussion | Failure modes, cross-file limits, D-in-D fragility, LLM token effects |
| Appendix A | Corpus case descriptions |
| Appendix B | Sample tool invocation traces (`report.tool_invocations`) |
| Appendix C | LLM prompt versions (`prompts/` YAML files) |

**Estimated effort:** 5–6 days

---

## 6. Success Metrics

### Primary Thesis Metrics

| Metric | Target | Measurement |
|---|---|---|
| **Recall** (orchestrated mode) | ≥ 0.75 | `evaluation_summary.json` aggregate |
| **Precision** (orchestrated mode) | ≥ 0.70 | `evaluation_summary.json` aggregate |
| **Recall lift** (orchestrated vs. static-only) | ≥ +15 pp | Ablation comparison table |
| **Precision lift** (LLM judge vs. heuristic) | ≥ +5 pp | Judge comparison |
| **FP reduction** (LLM vs. heuristic) | ≥ 20% fewer FPs | `disagreement_analysis.json` |
| **Multi-turn improvement** | ≥ 1 case where turn 2+ changes verdict | Judge trace analysis |

### Secondary Metrics

| Metric | Target |
|---|---|
| Corpus size | ≥ 8 labeled cases (mix of synthetic + real-world-inspired) |
| Scan latency (`complex_leak_lab`, ~10 files) | ≤ 60 s with Valgrind |
| Scan latency (medium repo, ~500 files) | ≤ 8 min (`balanced` mode) |
| Ablation configurations tested | 4 |
| Fix suggestion correctness rate | ≥ 60% on TP bundles |

### Engineering Quality Metrics

| Metric | Target |
|---|---|
| Unit test coverage (MCP-Vul) | ≥ 70% |
| All corpus cases compilable | 100% — no empty directories |
| `sys.path` injection calls remaining | 0 after Phase 1 |
| Integration test pass rate | 100% |

---

## 7. Risk Assessment

### Phase 0

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| New corpus cases don't compile in Docker | Medium | High | Test with `docker run --rm -v $(pwd):/src gcc make CC=clang` |
| Valgrind doesn't confirm expected leaks (optimized away) | Medium | High | Use `volatile` pointer or `__attribute__((noinline))` |
| `expected_leak_count` counting convention ambiguous | High | Medium | One unique allocation callsite = one leak; document in manifest |

### Phase 1

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| sys.path fix breaks Docker builds | Medium | Medium | Test each Dockerfile in isolation with `--no-cache` |
| O(n²) fix introduces merge regressions | Low | High | Run all false-merge regression tests; add 200-bundle stress test |
| Retry causes infinite loop under broken server | Low | Medium | Hard cap: `max_attempts * backoff_sec_max < 30s` |

### Phase 2

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cross-file symbol table slow for large repos | Medium | Medium | `--skip-project-symbol-table` flag; lazy load for candidate files only |
| tree-sitter AST gate causes false negatives on parse failure | Medium | High | Always fall back to lexical result on parse error |

### Phase 3

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Multi-turn LLM inflates API cost | High | Medium | Default `MAX_TURNS=1`; only for `inconclusive` bundles |
| LLM API unavailable at thesis deadline | Medium | High | Heuristic fallback always available; document which runs used LLM |
| Multi-turn shows no improvement over single-turn | Medium | Medium | Valid publishable finding — document in Discussion chapter |
| Token budget truncation removes dynamic evidence | Medium | Medium | Never truncate Valgrind/ASan findings; truncation order documented |

### Phase 4

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| MCP SDK migration breaks tests | Medium | High | Migrate one server at a time; feature flag on old `http_server.py` |
| Phase 4 not completed before deadline | High | Low | Explicitly optional; mark as future work |

### Phase 5

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Corpus too small for statistical significance | Medium | High | Report confidence intervals; cite corpus size as limitation |
| LLM judge shows no improvement over heuristic | Medium | High | Valid finding; analyze failure modes; frame as boundary conditions |
| Evaluation runs exceed time budget (Valgrind slow) | Medium | Medium | Pre-compute Valgrind runs; cache run IDs for re-evaluation |

---

## 8. Appendix — File Map

```
Thesis/
├── PLAN.md                                    ← this file
├── ARCHITECTURE.md                            ← system architecture documentation
├── CLAUDE.md                                  ← AI assistant guidance
├── THESIS_IMPLEMENTATION_TODO.md              ← completed implementation checklist
├── docker-compose.yml                         ← full demo stack (4 services)
├── pyproject.toml + uv.lock                   ← root workspace metadata
│
├── demo/memory_leak_corpus/
│   ├── corpus_manifest.json                   ← C-02: expand to ≥8 cases (P0.2)
│   ├── simple_leak/                           ← C-01: EMPTY → fix in P0.1
│   │   ├── Makefile                           ← CREATE (P0.1)
│   │   ├── make_buffer.h / make_buffer.c      ← CREATE (P0.1)
│   │   └── main.c                             ← CREATE (P0.1)
│   └── complex_leak_lab/                      ← ✅ working (8 leaks, 5 files)
│
├── results/
│   ├── baselines/                             ← CREATE in P0.4
│   │   ├── static_lexical_only/
│   │   ├── orchestrated_heuristic/
│   │   └── README.md                         ← baseline precision/recall table
│   ├── corpus/evaluation_summary.json         ← CREATE in P0.3
│   ├── ablation/                              ← CREATE in P5.1
│   │   ├── static_lexical_only/
│   │   ├── static_full/
│   │   ├── static_plus_dynamic/
│   │   ├── orchestrated_llm/
│   │   └── comparison_table.json
│   ├── judge_comparison/                      ← CREATE in P5.3
│   └── fix_quality/                           ← CREATE in P5.4
│
├── MCP-Vul/src/
│   └── memory_leak/
│       ├── control_plane.py                   ← add retry (P1.3), ablation (P5.1)
│       ├── candidate_manager.py               ← fix O(n²) dedup (P1.2)
│       ├── judge.py                           ← multi-turn (P3.1), token budget (P3.3)
│       ├── investigation_policy.py            ← LLM policy mode (P3.4)
│       ├── shared_schema.py                   ← REMOVE sys.path hack (P1.1)
│       ├── reporting.py                       ← add LaTeX output (P5.2)
│       ├── batch_runner.py                    ← add score/ablation commands (P0.3, P5.1)
│       ├── compare_snapshots.py               ← format flags (P5.2)
│       └── prompts/                           ← CREATE (P3.2)
│           ├── judge_single_turn_v1.yaml
│           ├── judge_batch_v1.yaml
│           └── judge_multiturn_v1.yaml
│
├── mcp-memory-static-analysis-server/
│   └── tools/
│       ├── candidate_scan.py                  ← AST gate (P2.3)
│       ├── interprocedural_flow.py            ← cross-file support (P2.1)
│       └── project_symbol_table.py            ← CREATE (P2.1)
│
└── mcp-dynamic-analysis-server/src/core/
    └── shared_schema.py                       ← REMOVE sys.path hack (P1.1)
