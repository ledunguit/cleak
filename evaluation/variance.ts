/**
 * Variance-report markdown for `--runs>1`, format-matched to
 * `scripts/evaluate-corpus.ts`'s (non-exported) `varianceMarkdown()`.
 */
import type { RepeatedEvalResult } from '../apps/leak-inspector-tui/src/domain/evalHarness';

export function varianceMarkdown(rep: RepeatedEvalResult): string {
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
