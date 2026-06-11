#!/usr/bin/env bun
/**
 * Batch corpus evaluation (v2 harness). Runs the leak-inspector-tui headless
 * scanner over every labeled case in a v2 corpus, scores findings against the
 * per-function / per-line ground truth, and writes the thesis metric artifacts
 * (metrics.json/csv, report.md, tables.tex) via the shared eval harness +
 * reporter. Records reproducibility provenance (model/temperature/tool versions/
 * git commit/corpus hash) and, with --runs>1, mean ± std across independent runs
 * so LLM-sampling variance is reported rather than hidden behind a single pass.
 *
 *   bun scripts/evaluate-corpus.ts                          # llm_assisted, all cases
 *   bun scripts/evaluate-corpus.ts no_llm                   # deterministic baseline
 *   bun scripts/evaluate-corpus.ts llm_assisted --limit 3   # first 3 cases
 *   bun scripts/evaluate-corpus.ts llm_assisted --runs 5    # 5 runs, report variance
 *   bun scripts/evaluate-corpus.ts no_llm --dynamic selective --corpus demo/juliet_cwe401
 *
 * In this dev environment the docker stack holds 50061/50062 in gRPC mode, so the
 * MCP analyzers run on 50071/50072; override with EVAL_STATIC_URL / EVAL_DYNAMIC_URL.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { runEval, runEvalRepeated, type EvalResult, type RepeatedEvalResult } from '../apps/leak-inspector-tui/src/domain/evalHarness';
import { writeEval } from '../apps/leak-inspector-tui/src/domain/evalReport';
import { loadEnvFiles } from '../apps/leak-inspector-tui/src/domain/env';

loadEnvFiles();

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const mode = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'llm_assisted') as
  | 'no_llm'
  | 'llm_assisted';
const limit = flag('limit') ? parseInt(flag('limit')!, 10) : undefined;
const runs = flag('runs') ? Math.max(1, parseInt(flag('runs')!, 10)) : 1;
const dynamic = (flag('dynamic') as 'off' | 'selective' | 'aggressive') ?? 'off';
const corpusDir = flag('corpus') ?? process.env.CORPUS_DIR ?? 'demo/juliet_cwe401';
const staticUrl = process.env.EVAL_STATIC_URL ?? 'http://127.0.0.1:50071/mcp';
const dynamicUrl = process.env.EVAL_DYNAMIC_URL ?? 'http://127.0.0.1:50072/mcp';

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = join(process.env.RESULTS_DIR ?? 'results', `eval-${mode}-${stamp}`);
mkdirSync(outDir, { recursive: true });

const baseOpts = { corpusDir, mode, dynamic, limit, concurrency: undefined, resume: false, staticUrl, dynamicUrl };
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log(`Evaluating corpus=${corpusDir} mode=${mode} dynamic=${dynamic} runs=${runs}${limit ? ` limit=${limit}` : ''}\n`);

if (runs <= 1) {
  const result: EvalResult = await runEval({ ...baseOpts, outDir });
  const files = writeEval(outDir, result);
  const m = result.overall;
  console.log(`\n── ${mode} ── ${result.ranOk}/${result.caseCount} scored`);
  console.log(`  P ${pct(m.precision)} · R ${pct(m.recall)} · F1 ${m.f1.toFixed(3)} · MCC ${m.mcc.toFixed(3)} · ECE ${result.ece.toFixed(3)}`);
  console.log(`  TP ${m.tp} FP ${m.fp} FN ${m.fn} TN ${m.tn}`);
  console.log(`  provenance: model=${result.provenance.model ?? '—'} temp=${result.provenance.temperature ?? '—'} commit=${result.provenance.gitCommit?.slice(0, 8) ?? '—'}`);
  console.log(`\n✓ artifacts: ${files.map((f) => basename(f)).join(', ')} in ${outDir}`);
} else {
  const rep: RepeatedEvalResult = await runEvalRepeated({ ...baseOpts, outDir }, runs);
  for (let i = 0; i < rep.perRun.length; i++) writeEval(join(outDir, `run-${i + 1}`), rep.perRun[i]);
  writeFileSync(join(outDir, 'variance.json'), JSON.stringify(rep, null, 2));
  writeFileSync(join(outDir, 'variance.md'), varianceMarkdown(rep));
  const a = rep.aggregate;
  const pm = (s: { mean: number; std: number }) => `${(s.mean * 100).toFixed(1)}% ± ${(s.std * 100).toFixed(1)}`;
  console.log(`\n── ${mode} · ${rep.runs} runs (mean ± std) ──`);
  console.log(`  P ${pm(a.precision)} · R ${pm(a.recall)} · F1 ${a.f1.mean.toFixed(3)} ± ${a.f1.std.toFixed(3)}`);
  console.log(`  MCC ${a.mcc.mean.toFixed(3)} ± ${a.mcc.std.toFixed(3)} · ECE ${a.ece.mean.toFixed(3)} ± ${a.ece.std.toFixed(3)}`);
  console.log(`\n✓ variance.json + per-run artifacts in ${outDir}`);
}

function varianceMarkdown(rep: RepeatedEvalResult): string {
  const a = rep.aggregate;
  const row = (label: string, s: { mean: number; std: number; min: number; max: number }) =>
    `| ${label} | ${s.mean.toFixed(3)} | ${s.std.toFixed(3)} | ${s.min.toFixed(3)} | ${s.max.toFixed(3)} |`;
  const p = rep.provenance;
  return [
    `# Variance report — ${rep.mode}${rep.dynamic !== 'off' ? ` +dynamic(${rep.dynamic})` : ''} · ${rep.runs} runs`,
    '',
    `- Model: ${p.model ?? '— (no_llm)'} · temperature ${p.temperature ?? '—'} · provider ${p.provider ?? '—'}`,
    `- Git commit: ${p.gitCommit ?? '—'} · corpus hash: ${p.corpusHash ?? '—'}`,
    '',
    '| metric | mean | std | min | max |',
    '|---|--:|--:|--:|--:|',
    row('Precision', a.precision),
    row('Recall', a.recall),
    row('F1', a.f1),
    row('Accuracy', a.accuracy),
    row('MCC', a.mcc),
    row('ECE', a.ece),
    '',
  ].join('\n');
}
