# CLeak: LLM-Orchestrated Unified Static and Dynamic Analysis for C/C++ Memory Leak Detection

[![CI](https://github.com/ledunguit/cleak/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/ledunguit/cleak/actions/workflows/ci.yml)
[![Release](https://github.com/ledunguit/cleak/actions/workflows/release.yml/badge.svg)](https://github.com/ledunguit/cleak/actions/workflows/release.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

*Đọc bằng tiếng Việt: [README_vi.md](README_vi.md)*

This repository is the research artifact accompanying a Master's thesis on
**LLM-orchestrated memory leak detection for C/C++**. It contains the full system
(analyzers, orchestrator, judge layer), the evaluation harness, the baseline
configurations, and the reproducibility gates the thesis's reported numbers are
generated from — not merely the illustrative examples in the paper.

> **Start here:** the thesis overview lives at [docs/THESIS.md](docs/THESIS.md)
> (one page: problem, system, contributions, headline results); the full document
> index is [docs/README.md](docs/README.md).

## Abstract

Memory leaks (CWE-401) in C/C++ are a class of defect that produces no crash: the
program keeps running while consuming memory it never releases, which makes the
defect hard to surface through ordinary testing. Static analyzers (Clang Static
Analyzer, Infer) flag candidates without executing the program but suffer from
incomplete path/ownership reasoning and a high false-positive rate; dynamic tools
(Valgrind Memcheck, AddressSanitizer/LeakSanitizer) provide certain evidence but
only for paths that are actually exercised. Both stop at a *warning* — neither
explains **why** a leak occurs or proposes **how** to fix it.

CLeak lets an **LLM orchestrate** the investigation instead: a three-phase agentic
loop (**discovery → investigation → judging/reporting**) that adaptively selects
which static or dynamic tool to run next, fuses the resulting evidence into
per-site *leak bundles*, and produces a **verdict, a root-cause explanation, and
an applicable fix** — evaluated end-to-end against a heuristic-only baseline and a
9-baseline capability ablation on a validated NIST Juliet CWE-401 corpus plus a
real-project corpus (LAMeD).

## Key Contributions

1. **Consensus judge — static/dynamic fusion with self-consistency.** A judge that
   samples *k* independent LLM verdicts and combines them (`majority` /
   `weighted` / `unanimous-to-flag`), cutting verdict-flip rate on borderline
   cases by roughly 2–4× versus a single-sample LLM judge.
2. **Two-tier reproducibility protocol.** Tier-1 (`no_llm`, deterministic
   heuristic + pinned dynamic recipe) is bitwise-deterministic across runs and is
   enforced by a CI gate that rejects two specific false-pass failure modes
   observed during development. Tier-2 (`llm_assisted`) is reported as a
   distribution (mean ± std over repeated runs, verdict-flip rate) rather than a
   single point estimate, since bitwise determinism is not achievable with a
   sampled LLM judge.
3. **A deterministic dynamic-evidence stage.** The dynamic path (build + sanitizer
   run) is a pinned recipe, not an LLM sub-agent decision — so dynamic coverage
   and findings do not vary run-to-run, isolating LLM-induced non-determinism to
   the judge alone.
4. **Structured evidence enrichment for the judge.** Every candidate carries
   ownership analysis, alloc→free pairing, and a feasible-leak-path narrative,
   plus a `correlationMethod` that distinguishes strongly-linked (file/line/
   function-matched) static↔dynamic correlation from weak (file-only) matches.

Full write-up with measured results and honest threats-to-validity discussion:
[docs/CONTRIBUTION.md](docs/CONTRIBUTION.md).

## System Overview

A single orchestration path — a CLI/TUI (`apps/leak-inspector-tui`) built on a
framework-free native tool-calling core (`packages/agent-core`) — drives two
analyzer services over MCP (Model Context Protocol):

| Stage | Component | Role |
|---|---|---|
| Discovery + static evidence | `apps/static-analyzer` | Tree-sitter AST, call graph, interprocedural flow, ownership analysis, Clang `scan-build` |
| Dynamic evidence | `apps/dynamic-analyzer` | Valgrind Memcheck, AddressSanitizer, LeakSanitizer (build + sanitizer run) |
| Fusion + judging | `packages/common` | Heuristic / single-LLM / consensus judge, three directly-comparable configurations |

An earlier web implementation (NestJS control-plane + React SPA) was removed from
`master` and is preserved on the `web-implementation` branch; `master` is
CLI/TUI-only.

Full component/protocol/pipeline detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
· runtime sequence diagrams: [docs/sequence-diagrams.md](docs/sequence-diagrams.md)
· every LLM prompt used in the system: [docs/PROMPTS.md](docs/PROMPTS.md).

## Results

Measured on the **validated** NIST Juliet CWE-401 corpus (1,658 cases, content-hash
`f578c3ee…`; full validation protocol: [docs/EVALUATION.md §8](docs/EVALUATION.md)).
All numbers below are real measured runs — see
[docs/BASELINE-COMPARISON.md](docs/BASELINE-COMPARISON.md) for reproduction commands.

**System vs. static baseline** — 9-baseline capability ablation
(`configs/baselines/*.yaml`), stratified sample n=50:

| System | Precision | Recall | F1 |
|---|---|---|---|
| **B6a — planner + pinned recipe + LLM judge (strongest configuration)** | **0.973** | 0.906 | **0.938** |
| B1 — static-only (deterministic heuristic, no LLM) | 0.792 | 0.792 | 0.792 |
| Clang Static Analyzer (same corpus, same scorer) | ~0.69 | ~0.84 | ~0.76 |

> **Full-corpus generalization (1,658 cases, static-only) is lower: P 0.680 / R 0.556
> / F1 0.612.** The stratified n=50 sample dilutes two hard families that dominate
> the full corpus — C++ `new`/`delete` (1,736 sites, 16.7% recall) and `malloc`
> (36.7% precision) — a genuine limitation at scale, reported here rather than
> omitted. See [docs/CONTRIBUTION.md](docs/CONTRIBUTION.md) for the full breakdown.

**Consensus judge reduces verdict instability** — 30 cases, 2 runs per branch, 2
independent replications (A/B):

| Judge branch | Verdict-flip rate | Modal agreement |
|---|---|---|
| Single-LLM (k=1) | 13.3–26.7% | 86.7–93.3% |
| **Consensus (k=3)** | **6.7%** (identical across both replications) | **96.7%** |

**Tier-1 determinism.** Two independent `no_llm` runs (separate output directories,
identical config) score byte-for-byte identically (TP29 FP7 FN3 TN38), enforced by
`scripts/determinism-gate.sh`.

## Reproducibility

- **`no_llm` mode is bitwise-deterministic** and gated in CI
  (`scripts/determinism-gate.sh` + `scripts/assert-determinism.ts`), which
  explicitly rejects two false-pass failure modes found during development
  (self-comparison via a timestamp collision, and a degenerate all-error run
  masquerading as "deterministic").
- **`llm_assisted` mode is reported as a distribution**, not a point estimate:
  `scripts/evaluate-corpus.ts --runs N` (mean ± std) and
  `scripts/verdict-stability.ts` (per-case verdict-flip rate).
- **Every corpus is validated before it can be used for evaluation**: a lockfile
  (`*.lock.json`) records a content-hash over every source file, checked at
  run time by `checkCorpusGate()` — a benchmark number is only as trustworthy as
  the data it was computed on.

Corpora used for evaluation — **NIST Juliet CWE-401** (synthetic, public-domain)
and **LAMeD** (EASE 2025, peer-reviewed, 41 confirmed leaks across 7 real C
projects) — are not committed and are rebuilt via
[docs/DATASETS.md](docs/DATASETS.md); no hand-labeled corpus is used as evaluation
ground truth.

## Getting Started

**1. Configure the CLI/TUI** (reads `~/.config/cleak/config.json`, not `.env`):

```bash
cd apps/leak-inspector-tui
pnpm install
cleak config init                      # write a fully-keyed config template
cleak config set provider openai       # or local / anthropic / openai-compat
cleak config set endpoints.openai.apiKey sk-...
```

Precedence: **CLI flag > config file > built-in default**. Details:
[apps/leak-inspector-tui/README.md](apps/leak-inspector-tui/README.md).

**2. Configure and start the analyzer services** (Docker, each serving MCP/HTTP):

```bash
cp apps/static-analyzer/.env.example  apps/static-analyzer/.env
cp apps/dynamic-analyzer/.env.example apps/dynamic-analyzer/.env
docker compose up --build
```

**3. Run a scan:**

```bash
cd apps/leak-inspector-tui
pnpm run dev                           # interactive TUI
# or headless:
pnpm exec tsx src/cli.ts scan --repo <path-to-a-c-or-cpp-repo>
```

**4. Reproduce an evaluation run:**

```bash
pnpm run eval:wizard                                   # guided, auto-ingests a corpus if missing
pnpm exec tsx evaluation/cli.ts --corpus demo/juliet_cwe401 --baseline B1,B6a,B7 --limit 200 --stratify
```

**Build everything:**

```bash
pnpm run build
```

## Repository Structure

```
cleak/
├── apps/
│   ├── static-analyzer/           ← static analysis, MCP/HTTP (port 50061)
│   ├── dynamic-analyzer/          ← dynamic analysis, MCP/HTTP (port 50062)
│   └── leak-inspector-tui/        ← orchestrator (CLI/TUI)
├── packages/
│   ├── common/                    ← shared types, Zod schemas, judges, report renderers (@cleak/common)
│   ├── config/                    ← config schema, loader/persister, CLI helpers (@cleak/config)
│   ├── agent-core/                ← native tool-calling loop, MCP client, callModel (@cleak/agent-core)
│   └── observability/             ← structured JSON logging (@cleak/observability)
├── configs/baselines/             ← 9 YAML capability-ablation configs (B1–B7)
├── evaluation/                    ← standalone evaluation CLI (guided wizard + auto-ingest + baseline sweeps)
├── scripts/                       ← evaluation/test/reproducibility scripts
├── docs/                          ← architecture, prompts, evaluation methodology, security, datasets
├── paper/                         ← thesis chapters + reference bibliography
├── demo/                          ← evaluation corpora (git-ignored; see docs/DATASETS.md)
├── results/                       ← run artifacts (git-ignored)
├── researchs/                     ← literature survey notes
└── docker-compose.yml
```

## Documentation

Start at [docs/THESIS.md](docs/THESIS.md); full index at [docs/README.md](docs/README.md).

| Document | Contents |
|---|---|
| [docs/THESIS.md](docs/THESIS.md) | One-page thesis overview |
| [docs/CONTRIBUTION.md](docs/CONTRIBUTION.md) | Contributions, measured results, threats to validity |
| [docs/RELATED-WORK.md](docs/RELATED-WORK.md) | Positioning against prior work, per-paper comparison |
| [docs/EVALUATION.md](docs/EVALUATION.md) | Evaluation methodology, metrics, reproducibility protocol |
| [docs/BASELINE-COMPARISON.md](docs/BASELINE-COMPARISON.md) | Baseline comparison runbook |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, protocols, pipeline diagrams |
| [docs/PROMPTS.md](docs/PROMPTS.md) | Every LLM prompt used by the system |
| [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md) | Full MCP tool reference (input schema, handler, JSON-RPC examples) |
| [docs/SECURITY.md](docs/SECURITY.md) | Trust model for executing untrusted code |
| [docs/DATASETS.md](docs/DATASETS.md) | Obtaining/rebuilding the evaluation corpora |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) · [docs/GLOSSARY.md](docs/GLOSSARY.md) · [docs/GOAL.md](docs/GOAL.md) | Runbooks, terminology, success criteria |

## Related Work and Baselines

Only tools, papers, and datasets CLeak directly integrates or compares against are
listed here; full per-paper positioning is in
[docs/RELATED-WORK.md](docs/RELATED-WORK.md) and [`researchs/`](researchs/); the
complete numbered bibliography is
[paper/references/bibliography.md](paper/references/bibliography.md).

**Integrated tools** — Clang Static Analyzer (`scan-build`), Valgrind Memcheck,
AddressSanitizer, LeakSanitizer, Tree-sitter, Model Context Protocol.

**Direct leak-detection baselines** — **LAMeD** (EASE 2025, CORE-A, peer-reviewed;
the only other peer-reviewed leak-specific baseline; its AllocSource/FreeSink
annotation convention is the basis for CLeak's `extraAllocators`/
`extraDeallocators`) and **MemHint** (arXiv 2026, neuro-symbolic static + Z3 +
LLM-confirmation, evaluated on real projects).

**Comparable agentic architectures** — RepoAudit (ICML 2025 poster), FuzzingBrain
V2 (arXiv 2026), ATLANTIS (AIxCC 2025 winner), Buttercup (Trail of Bits).

**Design foundations** — ReAct (Yao et al., ICLR 2023) for the tool-calling loop;
Self-Consistency (Wang et al., ICLR 2023) for the consensus judge.

**Evaluation corpora** — NIST Juliet CWE-401 (SARD, public domain); LAMeD Zenodo
artifact (cJSON, 152 functions, DOI: [10.5281/zenodo.15089703](https://doi.org/10.5281/zenodo.15089703)).

## Citation

```bibtex
@mastersthesis{ledangdung2026cleak,
  title  = {CLeak: LLM-Orchestrated Unified Static and Dynamic Analysis for
            C/C++ Memory Leak Detection},
  author = {Le Dang Dung},
  year   = {2026},
  type   = {Master's Thesis}
}
```

## License

Apache License 2.0 — see [LICENSE](LICENSE).
