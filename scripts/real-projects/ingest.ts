#!/usr/bin/env bun
/**
 * Ingest real-project memory-leak cases from upstream leak-fix commits into a v2
 * labeled corpus the eval harness understands — using the LEAK-FIX-COMMIT ORACLE:
 * the pre-fix revision at the changed allocation site is a flaw (actual:true), the
 * post-fix revision is clean (actual:false). Each record yields TWO line-mode
 * cases, `<id>-bad` (the leaking revision) and `<id>-fixed` (the patched one),
 * paired at the same source location — the cleanest ground truth available for
 * real code (no hand-labeling, every label traceable to a real commit + diff).
 *
 * Sources (ground-truth.json) and the ingest script are committed; the
 * materialized `cases/` are git-ignored (regenerable, like the Juliet corpus).
 *
 * Usage:
 *   bun scripts/real-projects/ingest.ts \
 *     --ground-truth demo/real_projects/ground-truth.json \
 *     --out demo/real_projects [--clones /tmp/real-projects-clones]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

interface GroundTruthRecord {
  id: string;
  project: string;
  file: string;
  headers?: string[];
  fixCommit: string;
  function: string;
  flawLine: number;
  fixedLine: number;
  cwe?: string;
  description?: string;
}
interface GroundTruth {
  name?: string;
  projects: Record<string, { repo: string }>;
  records: GroundTruthRecord[];
}

const gtPath = arg('ground-truth', 'demo/real_projects/ground-truth.json')!;
const outDir = resolve(arg('out', 'demo/real_projects')!);
const clonesDir = resolve(arg('clones', join(outDir, '.clones'))!);

const gt = JSON.parse(readFileSync(gtPath, 'utf-8')) as GroundTruth;

/** git in a repo dir, captured. */
function git(repoDir: string, args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

/** Ensure a project repo is cloned (full history, so any fixCommit resolves). */
function ensureClone(project: string, repo: string): string {
  const dir = join(clonesDir, project);
  if (existsSync(join(dir, '.git'))) return dir;
  mkdirSync(clonesDir, { recursive: true });
  process.stdout.write(`  cloning ${repo} → ${dir}\n`);
  execFileSync('git', ['clone', '--quiet', repo, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  return dir;
}

/** File content at a given revision (throws if the path/rev is wrong — fail loud). */
function fileAt(repoDir: string, rev: string, path: string): string {
  return git(repoDir, ['show', `${rev}:${path}`]);
}

interface ManifestCase {
  id: string;
  repo_path: string;
  cwe?: string;
  flaws?: Array<{ function: string; file: string; line: number; cwe?: string }>;
  clean?: Array<{ function: string; file: string; line: number }>;
}

const cases: ManifestCase[] = [];
mkdirSync(join(outDir, 'cases'), { recursive: true });

for (const rec of gt.records) {
  const proj = gt.projects[rec.project];
  if (!proj) {
    process.stderr.write(`  ! unknown project '${rec.project}' for ${rec.id} — skipped\n`);
    continue;
  }
  const repoDir = ensureClone(rec.project, proj.repo);
  const fileBase = basename(rec.file);

  // Materialize one case per revision: pre-fix (leaking) and post-fix (clean).
  const variants: Array<{ suffix: 'bad' | 'fixed'; rev: string; line: number; kind: 'flaw' | 'clean' }> = [
    { suffix: 'bad', rev: `${rec.fixCommit}^`, line: rec.flawLine, kind: 'flaw' },
    { suffix: 'fixed', rev: rec.fixCommit, line: rec.fixedLine, kind: 'clean' },
  ];

  for (const v of variants) {
    const caseId = `${rec.id}-${v.suffix}`;
    const caseDir = join(outDir, 'cases', caseId);
    rmSync(caseDir, { recursive: true, force: true });
    mkdirSync(caseDir, { recursive: true });
    try {
      writeFileSync(join(caseDir, fileBase), fileAt(repoDir, v.rev, rec.file));
      for (const h of rec.headers ?? []) {
        writeFileSync(join(caseDir, basename(h)), fileAt(repoDir, v.rev, h));
      }
    } catch (err: any) {
      process.stderr.write(`  ! ${caseId}: ${err?.message ?? err} — skipped\n`);
      rmSync(caseDir, { recursive: true, force: true });
      continue;
    }
    const label = { function: rec.function, file: fileBase, line: v.line };
    cases.push({
      id: caseId,
      repo_path: `cases/${caseId}`,
      cwe: rec.cwe,
      ...(v.kind === 'flaw' ? { flaws: [{ ...label, cwe: rec.cwe }] } : { clean: [label] }),
    });
    process.stdout.write(`  ✓ ${caseId} (${v.kind} @ ${fileBase}:${v.line} in ${rec.function})\n`);
  }
}

const manifest = {
  schema_version: 'memory-leak-corpus/v2',
  name: gt.name ?? 'real-projects-leak',
  source: 'Upstream leak-fix commits (see ground-truth.json)',
  buildable: false,
  cases,
};
writeFileSync(join(outDir, 'corpus_manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(`\n✓ wrote ${cases.length} cases → ${join(outDir, 'corpus_manifest.json')}\n`);
