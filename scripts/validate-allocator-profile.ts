/**
 * Validate the LLM ALLOCATOR PROFILER against the frozen ground truth.
 *
 * For each project in a materialized corpus, run `profileAllocators` (LLM) on one of
 * its case repos and score the discovered allocator/deallocator names against the
 * hardcoded `PROJECT_ALLOCATORS`/`PROJECT_DEALLOCATORS` (which the benchmark freezes
 * and uses for the actual leak eval). Reports precision/recall/F1 of allocator-NAME
 * discovery per project + aggregate — the metric that justifies replacing the
 * hardcoded lists with dynamic LLM discovery WITHOUT making the leak eval
 * non-deterministic (the eval still uses the frozen lists).
 *
 *   bun scripts/validate-allocator-profile.ts --corpus <dir-with-corpus_manifest.json>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCallModel } from '@cleak/agent-core';
import { loadEnvFiles } from '../apps/leak-inspector-tui/src/domain/env';
import { loadConfig } from '../apps/leak-inspector-tui/src/config';
import { toProviderSettings } from '../apps/leak-inspector-tui/src/orchestrator/toolWrappers';
import { profileAllocators } from '../apps/leak-inspector-tui/src/domain/allocatorProfiler';
import { PROJECT_ALLOCATORS, PROJECT_DEALLOCATORS } from './lamed/ingest';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Score {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  missed: string[];
  extra: string[];
}

function score(discovered: string[], truth: string[]): Score {
  const D = new Set(discovered);
  const T = new Set(truth);
  const tp = [...D].filter((x) => T.has(x)).length;
  const fp = [...D].filter((x) => !T.has(x)).length;
  const fn = [...T].filter((x) => !D.has(x)).length;
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    tp,
    fp,
    fn,
    precision,
    recall,
    f1,
    missed: [...T].filter((x) => !D.has(x)),
    extra: [...D].filter((x) => !T.has(x)),
  };
}

async function main() {
  loadEnvFiles();
  const corpusDir = flag('corpus');
  if (!corpusDir) {
    console.error('usage: bun scripts/validate-allocator-profile.ts --corpus <dir>');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(join(corpusDir, 'corpus_manifest.json'), 'utf-8'));
  const cfg = loadConfig({});
  const callModel = buildCallModel(toProviderSettings(cfg), () => globalThis.crypto.randomUUID());

  // One representative case repo per project (the allocator API is project-wide).
  const repoByProject = new Map<string, string>();
  for (const c of manifest.cases ?? []) {
    const proj = c.functionalVariant;
    if (proj && PROJECT_ALLOCATORS[proj] && !repoByProject.has(proj)) {
      repoByProject.set(proj, join(corpusDir, c.repo_path));
    }
  }

  console.log(`Validating LLM allocator profiler vs frozen ground truth (${repoByProject.size} project(s))`);
  console.log(`model: ${cfg.llm.provider}/${cfg.llm.model} temp=${cfg.llm.temperature}\n`);

  const rows: { project: string; alloc: Score; dealloc: Score }[] = [];
  for (const [project, repo] of repoByProject) {
    process.stderr.write(`  profiling ${project} …\n`);
    const profile = await profileAllocators(repo, callModel, { temperature: cfg.llm.temperature });
    const alloc = score(profile?.allocators ?? [], PROJECT_ALLOCATORS[project] ?? []);
    const dealloc = score(profile?.deallocators ?? [], PROJECT_DEALLOCATORS[project] ?? []);
    rows.push({ project, alloc, dealloc });
    console.log(`▸ ${project}`);
    console.log(`  allocators   P ${(alloc.precision * 100).toFixed(0)}% R ${(alloc.recall * 100).toFixed(0)}% F1 ${alloc.f1.toFixed(2)}  (tp${alloc.tp} fp${alloc.fp} fn${alloc.fn})`);
    if (alloc.missed.length) console.log(`    missed: ${alloc.missed.join(', ')}`);
    if (alloc.extra.length) console.log(`    extra:  ${alloc.extra.join(', ')}`);
    console.log(`  deallocators P ${(dealloc.precision * 100).toFixed(0)}% R ${(dealloc.recall * 100).toFixed(0)}% F1 ${dealloc.f1.toFixed(2)}  (tp${dealloc.tp} fp${dealloc.fp} fn${dealloc.fn})`);
    if (dealloc.missed.length) console.log(`    missed: ${dealloc.missed.join(', ')}`);
    if (profile?.ownershipNotes?.length) console.log(`    ownership notes: ${profile.ownershipNotes.slice(0, 3).join(' | ')}`);
    console.log('');
  }

  const agg = (sel: (r: { alloc: Score; dealloc: Score }) => Score) => {
    const tp = rows.reduce((n, r) => n + sel(r).tp, 0);
    const fp = rows.reduce((n, r) => n + sel(r).fp, 0);
    const fn = rows.reduce((n, r) => n + sel(r).fn, 0);
    const p = tp + fp ? tp / (tp + fp) : 1;
    const r = tp + fn ? tp / (tp + fn) : 1;
    return { p, r, f1: p + r ? (2 * p * r) / (p + r) : 0, tp, fp, fn };
  };
  const a = agg((r) => r.alloc);
  const d = agg((r) => r.dealloc);
  console.log('═══ AGGREGATE ═══');
  console.log(`allocators   P ${(a.p * 100).toFixed(0)}% R ${(a.r * 100).toFixed(0)}% F1 ${a.f1.toFixed(2)}  (tp${a.tp} fp${a.fp} fn${a.fn})`);
  console.log(`deallocators P ${(d.p * 100).toFixed(0)}% R ${(d.r * 100).toFixed(0)}% F1 ${d.f1.toFixed(2)}  (tp${d.tp} fp${d.fp} fn${d.fn})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
