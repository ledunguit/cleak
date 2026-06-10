#!/usr/bin/env bun
/**
 * Compare the deterministic heuristic mode (no_llm) against the agentic mode
 * (llm_assisted) on the labeled corpus. Surfaces where the agent adds detections
 * or — just as important for the thesis — correctly dismisses false positives.
 *
 *   bun scripts/compare-modes.ts          # all cases
 *   bun scripts/compare-modes.ts 3        # first 3 cases
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHeadless } from '../apps/leak-inspector-tui/src/surfaces/headless';
import { loadEnvFiles } from '../apps/leak-inspector-tui/src/domain/env';

loadEnvFiles();

const limit = process.argv[2] ? parseInt(process.argv[2], 10) : Infinity;
const corpusDir = process.env.CORPUS_DIR ?? 'demo/memory_leak_corpus';
const staticUrl = process.env.EVAL_STATIC_URL ?? 'http://127.0.0.1:50071/mcp';

const manifest = JSON.parse(readFileSync(join(corpusDir, 'corpus_manifest.json'), 'utf-8')) as {
  cases: Array<{ id: string; repo_path: string; build_command?: string; expected_leak_count: number }>;
};
const cases = manifest.cases.slice(0, limit);

async function detect(repo: string, mode: 'no_llm' | 'llm_assisted', build?: string) {
  const r = await runHeadless({ repo, mode, dynamic: 'off', format: 'snapshot', build, staticUrl, quiet: true });
  const s = r.report.summary;
  const fp = r.report.bundles.filter(
    (b) => b.verdict?.verdict === 'false_positive' || b.verdict?.verdict === 'likely_false_positive',
  ).length;
  return { detected: s.confirmedLeaks + s.likelyLeaks, confirmed: s.confirmedLeaks, falsePositives: fp, candidates: s.totalCandidates };
}

const rows: any[] = [];
console.log(`Comparing no_llm vs llm_assisted on ${cases.length} case(s)\n`);
console.log(`  ${'case'.padEnd(22)} exp  no_llm  llm   Δ   notes`);

for (const c of cases) {
  const repo = join(corpusDir, c.repo_path);
  try {
    const base = await detect(repo, 'no_llm', c.build_command);
    const llm = await detect(repo, 'llm_assisted', c.build_command);
    const delta = llm.detected - base.detected;
    const notes: string[] = [];
    if (llm.falsePositives > base.falsePositives) notes.push(`+${llm.falsePositives - base.falsePositives} FP dismissed`);
    if (llm.confirmed > 0 && base.confirmed === 0) notes.push('llm gives confirmed verdicts');
    rows.push({ id: c.id, expected: c.expected_leak_count, no_llm: base.detected, llm_assisted: llm.detected, delta, base, llm });
    console.log(
      `  ${c.id.padEnd(22)} ${pad(c.expected_leak_count, 3)}  ${pad(base.detected, 6)}  ${pad(llm.detected, 4)}  ${pad(signed(delta), 3)}  ${notes.join('; ')}`,
    );
  } catch (err: any) {
    console.log(`  ${c.id.padEnd(22)} ERROR: ${err?.message ?? err}`);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.env.RESULTS_DIR ?? 'results', `compare-${stamp}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'compare.json'), JSON.stringify({ generated_at: new Date().toISOString(), rows }, null, 2));
console.log(`\n✓ wrote ${join(outDir, 'compare.json')}`);

function pad(v: string | number, n: number): string {
  return String(v).padStart(n);
}
function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
