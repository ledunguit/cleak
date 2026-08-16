# `evaluation/` — standalone evaluation CLI

A non-TUI equivalent of the TUI's `/eval` wizard. Same core (`runEval`/`runEvalRepeated`
from `apps/leak-inspector-tui/src/domain/evalHarness.ts`), same report artifacts, but no
Ink/TUI required — and unlike `scripts/evaluate-corpus.ts`, it can **ingest and validate a
missing corpus for you** instead of just failing.

## Quick start

```bash
# Guided wizard (omit --corpus, or pass --interactive)
pnpm run eval:wizard

# Flag-only, CI-friendly (no wizard, fails fast if the corpus isn't ready)
pnpm exec tsx evaluation/cli.ts no_llm --corpus demo/juliet_cwe401 --limit 50 --yes

# See the resolved plan without running anything
pnpm exec tsx evaluation/cli.ts no_llm --corpus demo/juliet_cwe401 --limit 3 --dry-run
```

## Wizard flow

1. Corpus (offers to ingest+validate on the spot if not ready — Juliet/LAMeD/MemHint or a
   custom path)
2. Sample size (all / N, with sequential / random / stratified sampling)
3. Analysis mode (`llm_assisted` / `no_llm`)
4. Dynamic analysis (`off` / `selective` / `aggressive`)
5. Concurrency (blank = harness default of 3)
6. Resume (+ out dir if yes)
7. Advanced options gate — provider/endpoint config, consensus, strategy, enrich, static
   tool selection, budget caps, explicit out dir, repeat runs (variance report)

Every prompt is pre-seeded from any CLI flag already supplied, so you can mix flags with
`--interactive` to skip only the prompts you care about.

## Auto-ingest

Picking a not-yet-validated corpus in the wizard offers to ingest it:

- **LAMeD / MemHint** — fully automatic, clones from the committed source manifest, then
  validates with `--strict-labels --skip-compile` (real-project, positive-only corpora —
  see `docs/DATASETS.md` for why the compile gate is skipped for these two).
- **Juliet** — point at a local extracted root or `.zip` (auto-detects `./juliet.zip` at
  repo root), or opt in to downloading the ~150MB NIST zip (off by default — network +
  disk heavy). Then validates with the standard compile-gate + label-drift checks.

Non-interactive/flag mode never auto-ingests — pass `--allow-unvalidated` to bypass the
gate instead, same as `evaluate-corpus.ts`.

## Baseline ablation configs (`configs/baselines/*.yaml`)

The same 9 declarative capability profiles (B1..B7 — static-only, dynamic-only, the full
adaptive orchestrator, etc.) that `scripts/run-baselines.ts` sweeps are runnable
here too, with the wizard's corpus picker + auto-ingest on top:

```bash
# One baseline, flag-only
pnpm exec tsx evaluation/cli.ts --corpus demo/juliet_cwe401 --baseline B1 --limit 300

# Several, or all of them
pnpm exec tsx evaluation/cli.ts --corpus demo/juliet_cwe401 --baseline B1,B3,B7 --limit 300
pnpm exec tsx evaluation/cli.ts --corpus demo/juliet_cwe401 --all-baselines --limit 300

# Interactively — omit --corpus (or add --interactive) and the CLI first asks
# "custom config or a baseline sweep?", then reuses the same corpus/ingest picker
pnpm run eval:wizard
```

`--baseline`/`--all-baselines` switch the CLI into sweep mode: it runs every selected
config over the SAME corpus sample and writes both the usual per-config `writeEval`
artifacts (`<outDir>/<id>/…`) and a comparison table — `baseline-sweep.{md,csv,tex,json}`
— at `<outDir>` (default `results/baseline-sweep-<timestamp>`), identical in shape to what
`scripts/run-baselines.ts` produces (see `evaluation/baselines.ts`; deliberately a separate
implementation from that script rather than a refactor of it, so the script's already-used
thesis numbers stay pinned). `--consensus-n`/`--runs`/`--enrich`/`--static-tools` override
every swept config's own defaults, same semantics as `run-baselines.ts`.

## Flags

Run `--help` for the full list. Superset of `scripts/evaluate-corpus.ts`'s flags plus
`--auto-ingest`, `--juliet-root`/`--juliet-zip`, `--yes`/`-y`, `--set-endpoint
<provider>.<field>=<value>` (repeatable, persists to `~/.config/cleak/config.json`),
`--interactive`, `--baseline`/`--all-baselines`/`--baselines-dir`/`--include-unwired`.

## Provider / endpoint config

The wizard's "Advanced → Provider" step can show and edit `endpoints.<provider>.*` in
`~/.config/cleak/config.json` — the same file `cleak config set` writes. This **persists**;
it is not a one-off override scoped to the current run (`EvalOptions` only carries
`provider`, not `baseUrl`/`model`/`apiKey` — see `evaluation/providerSetup.ts`).

## Output

Same artifacts as `evaluate-corpus.ts` (`writeEval`): JSON/Markdown/HTML/snapshot under
`<outDir>`. `--runs > 1` additionally writes `variance.json`/`variance.md` and one
`run-<n>/` subdirectory per repetition.

## Inspecting a sweep (`inspect.ts`)

Report the full metrics table for a `--baseline`/`--all-baselines` sweep output
directory **without re-running anything** — reads whatever is on disk right now, so
it's safe to point at a directory another process is still writing to (e.g. checking
progress over SSH mid-sweep):

```bash
pnpm exec tsx evaluation/inspect.ts results/baseline-sweep-<timestamp>
pnpm exec tsx evaluation/inspect.ts results/baseline-sweep-<timestamp> --baseline B1,B6b,B7
```

Finished baselines (single-run: `<id>/metrics.json`; multi-run: `<id>/variance.json`,
which — like `runEvalRepeated` itself — only exists once **every** repeat run has
completed) render as the exact `baseline-sweep.md` table via the real
`renderSweepMarkdown`. A baseline still mid-run (only `cases/*.json` cache files on
disk, no `metrics.json`/`variance.json` yet — this is also multi-run's state for
runs that finished caching all their cases but haven't been through the
end-of-group aggregation in `runBaselineSweep`) gets a live per-run progress line
instead: case count so far, any non-`ok` statuses, the judge `llm`/`heuristic`
ratio, running FP/KLOC, and a live F1 estimate. That judge ratio is the same
integrity signal `judgePathDistribution` reports at the end of a run — watch it
against the OTHER runs of the same baseline; a sudden drop (e.g. ~40% → ~20%) with
no visible errors is the silent LLM-judge-fallback-to-heuristic pattern (see
`llmJudge.ts`'s `judgeBundleWithLlm`), not necessarily a harder sample of cases.

Core logic lives in `inspectSweep.ts` (`aggregateCaseCache`, `inspectBaselineDir`) —
pure functions over a directory path, unit-tested without needing a real eval run.

## Tests

```bash
pnpm exec vitest run evaluation/tests
```

Pure-logic unit tests only (`corpusCatalog`, `flags`, `providerSetup`, `baselines`,
`inspectSweep`) — `cli.ts`/`run.ts`/`wizard.ts`/`ingestRunners.ts`/`inspect.ts` are
integration-style, verified by hand per the smoke tests below (matching the existing
bar: no `scripts/*.ts` entrypoint has its own test wrapper either, only pure helpers do).

### Manual smoke tests

```bash
# Dry run
pnpm exec tsx evaluation/cli.ts no_llm --corpus demo/juliet_cwe401 --limit 3 --dry-run

# Happy path against the already-validated Juliet corpus in this checkout
pnpm exec tsx evaluation/cli.ts no_llm --corpus demo/juliet_cwe401 --limit 3 --yes

# Juliet zip-ingest (repo root already has juliet.zip)
pnpm exec tsx evaluation/cli.ts no_llm --interactive --auto-ingest \
  --corpus demo/juliet-smoke-test --juliet-zip ./juliet.zip --limit 3 --yes
```
