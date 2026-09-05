# Project Goal

> Status: living document — mission + success criteria for the thesis system.
> Scope: LLM-orchestrated memory leak investigation for C/C++ repositories.

---

## Mission

Build an **agentic system in which an LLM orchestrates** the investigation of
memory leaks in C/C++ repositories. It combines **static analysis** (Clang
`scan-build`, Tree-sitter AST, call graph, interprocedural data-flow) and **dynamic analysis**
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

> → Đóng góp chi tiết + kết quả đo: [CONTRIBUTION.md](CONTRIBUTION.md) · Tổng quan: [THESIS.md](THESIS.md).

---

## Success criteria

| Status | Criterion |
|:---:|---|
| ✅ | Full `setup → scan → report` flow runs end-to-end (verified on the Docker stack). |
| ✅ | Realtime workflow nodes reflect the **actual** running flow, via a shared scan-flow contract (single source of truth in `packages/common`). |
| ✅ | Eval harness emits precision/recall comparing `no_llm` vs `llm_assisted` on the corpus (`pnpm run eval:compare` → `results/eval/comparison.{json,md}`). |
| ✅ | Every "leak" verdict ships a root-cause explanation **and** an applicable, source-anchored fix diff (heuristic *and* LLM paths). |

## Evaluation & metric notes

- **Scoring is site-based** (not count-based). Each ground-truth site → one `Sample`; a
  flagged clean site is a real FP, a missed flaw is a real FN. Full methodology (function/line
  mode, bootstrap CI, McNemar, two-tier determinism): [EVALUATION.md](EVALUATION.md). The
  research contribution is detailed in [CONTRIBUTION.md](CONTRIBUTION.md).
- **How to run** evals + baseline comparison + reproducibility gates: [OPERATIONS.md](OPERATIONS.md)
  and [BASELINE-COMPARISON.md](BASELINE-COMPARISON.md).
- **Current reproducible result** (Juliet CWE-401, **validated** 1658-case corpus): the full
  9-baseline sweep (single commit `5eec8b1`, `deepseek-v4-flash`, dynamic on, 3 runs/config) has
  **B6a** (planner + deterministic recipe + LLM judge) on top at **F1 0.863±0.001** (P0.965/R0.780,
  MCC 0.790), ahead of static-only B1 (F1 0.612) in the same sweep: see
  [EVALUATION.md §3b-bis](EVALUATION.md). The stratified n=50 ablation (`configs/baselines/`) also
  has B6a on top (F1 0.938, P0.973/R0.906, ahead of B1 0.792 and Clang ≈0.76), but that number is
  the component-ablation result on a family-balanced sample, not the whole-corpus headline: two
  weak families (`new`/C++ and `malloc`) dilute out of the stratified sample and pull the
  full-corpus score down (reconciliation in [CONTRIBUTION.md](CONTRIBUTION.md)). The consensus
  claim reversed on the n=50 stratified re-run: the single-LLM judge is both more stable (flip
  2.0% vs 8.0%) and more accurate (F1 0.852 vs 0.793), and McNemar over 205 paired sites leans
  single without statistical significance (χ²=3.13, p=0.077), so consensus is not recommended as
  the default (see [EVALUATION.md §7](EVALUATION.md)). (The older 30-case P0.806/R0.906/F1 0.853
  number was measured on a pre-remediation corpus defect and is superseded — do not cite it.)
- **`llm_assisted` needs a reachable LLM endpoint to diverge.** Without a key for a cloud
  provider the run fails loudly (no silent fallback to the heuristic). Provider/endpoint is
  selectable (`local | openai | anthropic | openai-compat`) — see [OPERATIONS.md](OPERATIONS.md).

---

## Non-goals

- Not a general-purpose SAST/DAST platform — scope is **memory leaks** in
  **C/C++** (Clang `scan-build` / Valgrind / ASan / LSan families).
- Not a replacement for the underlying analyzers — the LLM **orchestrates and
  judges** their output; it does not re-implement them.
- Not aiming for zero-config production hardening — the target is a
  reproducible **research/evaluation** harness for the thesis.

---

## Architecture at a glance

A standalone **`leak-inspector-tui`** (Ink CLI/TUI) is **the orchestrator**: it
runs the agentic loop via `packages/agent-core` (native tool-calling) and drives
a **static-analyzer** (`:50061`) and a **dynamic-analyzer** (`:50062`) over real
**MCP**, then writes report artifacts to `results/<scanId>/`. See
[THESIS.md](THESIS.md), [ARCHITECTURE.md](ARCHITECTURE.md), and `CLAUDE.md` for
the full architecture.

> The earlier web orchestration path (NestJS control-plane + React UI) is
> preserved on git branch `web-implementation`; `master` is TUI-only.
