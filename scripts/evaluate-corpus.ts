#!/usr/bin/env bun
/**
 * Corpus evaluation harness. Runs the leak-inspector-tui headless over every
 * labeled case in demo/memory_leak_corpus and scores detected leaks
 * (confirmed + likely) against each case's expected_leak_count. Writes a
 * machine-readable summary + a console table to results/eval-<ts>/.
 *
 *   bun scripts/evaluate-corpus.ts                 # llm_assisted, all cases
 *   bun scripts/evaluate-corpus.ts no_llm          # deterministic baseline
 *   bun scripts/evaluate-corpus.ts llm_assisted 3  # first 3 cases only
 *
 * In this dev environment the docker stack holds 50061/50062 in gRPC mode, so
 * the MCP analyzers run on 50071/50072; override with EVAL_STATIC_URL.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHeadless } from '../apps/leak-inspector-tui/src/surfaces/headless';
import { loadEnvFiles } from '../apps/leak-inspector-tui/src/domain/env';

loadEnvFiles();

const mode = (process.argv[2] as 'no_llm' | 'llm_assisted') ?? 'llm_assisted';
const limit = process.argv[3] ? parseInt(process.argv[3], 10) : Infinity;
const corpusDir = process.env.CORPUS_DIR ?? 'demo/memory_leak_corpus';
const staticUrl = process.env.EVAL_STATIC_URL ?? 'http://127.0.0.1:50071/mcp';

interface CorpusCase {
  id: string;
  repo_path: string;
  build_command?: string;
  expected_leak_count: number;
}

const manifest = JSON.parse(readFileSync(join(corpusDir, 'corpus_manifest.json'), 'utf-8')) as {
  cases: CorpusCase[];
};
const cases = manifest.cases.slice(0, limit);

interface Row {
  id: string;
  expected: number;
  detected: number;
  confirmed: number;
  likely: number;
  candidates: number;
  status: 'ok' | 'error';
  scanId?: string;
  error?: string;
}

const rows: Row[] = [];
console.log(`Evaluating ${cases.length} case(s) in mode=${mode}\n`);

for (const c of cases) {
  const repo = join(corpusDir, c.repo_path);
  try {
    const r = await runHeadless({
      repo,
      mode,
      dynamic: 'off',
      format: 'snapshot,json',
      build: c.build_command,
      staticUrl,
      quiet: true,
    });
    const s = r.report.summary;
    const detected = s.confirmedLeaks + s.likelyLeaks;
    rows.push({
      id: c.id,
      expected: c.expected_leak_count,
      detected,
      confirmed: s.confirmedLeaks,
      likely: s.likelyLeaks,
      candidates: s.totalCandidates,
      status: 'ok',
      scanId: r.scanId,
    });
    console.log(
      `  ${pad(c.id, 22)} expected=${pad(c.expected_leak_count, 2)} detected=${pad(detected, 2)} ` +
        `(C=${s.confirmedLeaks} L=${s.likelyLeaks}) candidates=${s.totalCandidates}`,
    );
  } catch (err: any) {
    rows.push({ id: c.id, expected: c.expected_leak_count, detected: 0, confirmed: 0, likely: 0, candidates: 0, status: 'error', error: err?.message });
    console.log(`  ${pad(c.id, 22)} ERROR: ${err?.message ?? err}`);
  }
}

// ── Aggregate (count-based; the corpus labels counts, not per-line ground truth) ──
const ok = rows.filter((r) => r.status === 'ok');
const totalExpected = ok.reduce((s, r) => s + r.expected, 0);
const totalDetected = ok.reduce((s, r) => s + r.detected, 0);
const recallNumerator = ok.reduce((s, r) => s + Math.min(r.detected, r.expected), 0);
const fullyDetected = ok.filter((r) => r.detected >= r.expected).length;
const recall = totalExpected ? recallNumerator / totalExpected : 0;

console.log(`\n── Aggregate (${mode}) ──`);
console.log(`  cases: ${ok.length}/${rows.length} ran`);
console.log(`  total expected: ${totalExpected} · total detected: ${totalDetected}`);
console.log(`  count-recall (Σmin(detected,expected)/Σexpected): ${(recall * 100).toFixed(1)}%`);
console.log(`  cases detecting ≥ expected: ${fullyDetected}/${ok.length}`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.env.RESULTS_DIR ?? 'results', `eval-${mode}-${stamp}`);
mkdirSync(outDir, { recursive: true });
const summary = {
  mode,
  generated_at: new Date().toISOString(),
  corpus: corpusDir,
  aggregate: { totalExpected, totalDetected, recall, fullyDetected, casesRan: ok.length },
  rows,
};
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\n✓ wrote ${join(outDir, 'summary.json')}`);

function pad(v: string | number, n: number): string {
  return String(v).padEnd(n);
}
