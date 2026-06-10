#!/usr/bin/env bun
/**
 * End-to-end smoke: run one headless scan and assert it completes with a leak
 * detected and an applicable repair diff. Fast sanity check for CI / local dev.
 *
 *   bun scripts/run-local-scan-smoke.ts [no_llm|llm_assisted] [repo]
 */

import { runHeadless } from '../apps/leak-inspector-tui/src/surfaces/headless';
import { loadEnvFiles } from '../apps/leak-inspector-tui/src/domain/env';

loadEnvFiles();

const mode = (process.argv[2] as 'no_llm' | 'llm_assisted') ?? 'no_llm';
const repo = process.argv[3] ?? 'demo/memory_leak_corpus/simple_leak';
const staticUrl = process.env.EVAL_STATIC_URL ?? 'http://127.0.0.1:50071/mcp';

const r = await runHeadless({ repo, mode, dynamic: 'off', format: 'snapshot,json', staticUrl, quiet: true });
const s = r.report.summary;
const detected = s.confirmedLeaks + s.likelyLeaks;
const withDiff = r.report.bundles.filter((b) => b.verdict?.repairDiff).length;

console.log(`scan ${r.scanId} (mode=${mode})`);
console.log(`  candidates=${s.totalCandidates} confirmed=${s.confirmedLeaks} likely=${s.likelyLeaks} repair_diffs=${withDiff}`);
console.log(`  reports: ${r.dir}`);

if (detected < 1) {
  console.error('✗ expected at least one detected leak');
  process.exit(1);
}
if (withDiff < 1) {
  console.error('✗ expected at least one applicable repair diff');
  process.exit(1);
}
console.log('✓ local scan smoke ok');
