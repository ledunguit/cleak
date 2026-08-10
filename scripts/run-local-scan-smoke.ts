#!/usr/bin/env -S tsx
/**
 * End-to-end smoke: run one headless scan and assert it completes with a leak
 * detected and an applicable repair diff. Fast sanity check for CI / local dev.
 *
 *   tsx scripts/run-local-scan-smoke.ts [no_llm|llm_assisted] [repo]
 */

import { runHeadless } from '../apps/leak-inspector-tui/src/surfaces/headless';
import { loadConfig } from '@cleak/config';

const cfg = loadConfig();

const mode = (process.argv[2] as 'no_llm' | 'llm_assisted') ?? 'no_llm';
const repo = process.argv[3] ?? 'apps/leak-inspector-tui/tests/fixtures/simple-leak';
const staticUrl = cfg.staticUrl;

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
