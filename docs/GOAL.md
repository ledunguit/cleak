# Project Goal

> Status: living document — mission + success criteria for the thesis system.
> Scope: LLM-orchestrated memory leak investigation for C/C++ repositories.

---

## Mission

Build an **agentic system in which an LLM orchestrates** the investigation of
memory leaks in C/C++ repositories. It combines **static analysis** (LeakGuard,
Tree-sitter AST, call graph, interprocedural data-flow) and **dynamic analysis**
(Valgrind Memcheck, AddressSanitizer, LeakSanitizer) so that the system does not
merely *detect* leaks, but produces **verifiable evidence, a root-cause
explanation, and an applicable fix**, packaged into multi-format reports.

The orchestration is a **3-phase agentic loop** — `discovery → investigation
loop → judging/reporting` — where the investigation loop lets the LLM (or a
heuristic fallback) decide which analysis tool to run next, turn by turn.

---

## Functional goals

Every scan must deliver all five of the following:

| # | Deliverable | Produced in |
|---|-------------|-------------|
| 1 | **Detect** memory-leak candidates in the repository | discovery |
| 2 | **Evidence** — static + dynamic findings normalized into shared *leak bundles* | investigation loop |
| 3 | **Explain why** the leak happens — allocation → leak path → root cause | judging |
| 4 | **Suggest a fix** as an applicable **diff** | judging |
| 5 | **Report** the result in **JSON / Markdown / HTML / Snapshot** | reporting |

---

## Research goals (thesis contribution)

- Compare **`llm_assisted`** (agentic, LLM-driven tool selection) against
  **`no_llm`** (deterministic heuristic) on the same labeled corpus.
- Measure **precision / recall** of leak verdicts per mode.
- Demonstrate that LLM orchestration adds value: better verdicts, fewer false
  positives, and useful explanations + fixes.
- Keep results **reproducible** via snapshots and committed baselines.

---

## Success criteria

| Status | Criterion |
|:---:|---|
| ✅ | Full `setup → scan → report` flow runs end-to-end (verified on the Docker stack). |
| ✅ | Realtime workflow nodes reflect the **actual** running flow, via a shared scan-flow contract (single source of truth in `packages/common`). |
| ✅ | Eval harness emits precision/recall comparing `no_llm` vs `llm_assisted` on the corpus (`bun run eval:compare` → `results/eval/comparison.{json,md}`). |
| ✅ | Every "leak" verdict ships a root-cause explanation **and** an applicable, source-anchored fix diff (heuristic *and* LLM paths). |

## Evaluation & metric notes

- **How to run the comparison** (live stack): `EVAL_API_TOKEN=<jwt> bun scripts/compare-modes.ts --via api --api-url http://localhost:8090 --corpus-root /workspace/demo/memory_leak_corpus`. Emits `results/eval/comparison.json` (schema `memory-leak-mode-comparison/v1`, with per-mode aggregates, ΔP/ΔR/ΔF1, and LLM-vs-heuristic attribution) + a human-readable `comparison.md`. `--via inprocess` runs without the API; `--via reuse` scores saved artifacts.
- **Metric is count-based.** Ground truth is the per-case `expected_leak_count` in `corpus_manifest.json` — there are no per-site labels and no clean/negative (count = 0) cases. So `predicted = #(confirmed_leak)+#(likely_leak)`, `tp = min(predicted, expected)`, `fp = max(0, predicted−expected)`, `fn = max(0, expected−predicted)`. This measures detection *counts*, not whether the flagged *locations* are the true leak sites, and cannot measure false positives on clean code. Treat the numbers as count-precision/recall.
- **Current reproducible no_llm result** (heuristic, dynamic off): macro P/R/F1 ≈ **0.89 / 0.75 / 0.74**, micro ≈ 0.86 / 0.58 / 0.69. The heuristic verdict now uses a source-level structural signal (locating the missing-free site) as static evidence, so `no_llm` actually detects leaks rather than returning all-`uncertain`.
- **`llm_assisted` needs an API key to diverge.** With no `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` configured, the LLM judge falls back to the heuristic, so both modes are identical (Δ = 0) and the attribution shows `heuristic` only. Set a provider key on the control-plane to exercise the real LLM judge.

---

## Non-goals

- Not a general-purpose SAST/DAST platform — scope is **memory leaks** in
  **C/C++** (LeakGuard / Valgrind / ASan / LSan families).
- Not a replacement for the underlying analyzers — the LLM **orchestrates and
  judges** their output; it does not re-implement them.
- Not aiming for zero-config production hardening — the target is a
  reproducible **research/evaluation** harness for the thesis.

---

## Architecture at a glance

NestJS microservices: **control-plane** (orchestrator, HTTP `:8090`) drives a
**static-analyzer** (`:50051`) and a **dynamic-analyzer** (`:50052`) over gRPC
or real MCP; a **React** UI (`:5173`) renders the scan timeline and workflow
DAG over SSE. See `research-plan.md` and `CLAUDE.md` for the full architecture.
