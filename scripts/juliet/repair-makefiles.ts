#!/usr/bin/env -S tsx
/**
 * One-off repair for an already-materialized demo/juliet_cwe401 corpus, without
 * needing the original NIST zip: regenerates every case's Makefile with the fixed
 * template (makefile-template.ts — split-file duplicate-`main` fix), patches
 * corpus_manifest.json's `build_command` to the `make clean && …` form, and purges
 * stray build artifacts (`*.o`, `a.out*`, ad-hoc binaries from earlier manual builds)
 * that a bare `make clean` (which only knows about `*.o`/`a.out`) would leave behind.
 *
 * Usage: tsx scripts/juliet/repair-makefiles.ts [--corpus demo/juliet_cwe401] [--dry-run]
 */
import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { generateJulietMakefile, JULIET_BUILD_COMMAND } from './makefile-template';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const dryRun = process.argv.includes('--dry-run');
const corpusDir = arg('corpus') ?? 'demo/juliet_cwe401';
const manifestPath = join(corpusDir, 'corpus_manifest.json');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
  cases: Array<{ id: string; repo_path: string; build_command?: string; _provenance?: { files?: Array<{ name: string }> } }>;
};

const KEEP_RE = /\.(c|cpp|h|hpp)$/i;

let repaired = 0;
let strayRemoved = 0;
let manifestPatched = 0;

for (const c of manifest.cases) {
  if (!c.build_command || !c._provenance?.files?.length) continue;
  const caseDir = join(corpusDir, c.repo_path);
  const testcaseBasenames = c._provenance.files.map((f) => f.name);

  // Purge stray artifacts: keep only source/header files + Makefile.
  let entries: string[] = [];
  try {
    entries = readdirSync(caseDir);
  } catch {
    continue;
  }
  for (const name of entries) {
    if (name === 'Makefile' || KEEP_RE.test(name)) continue;
    const full = join(caseDir, name);
    if (statSync(full).isDirectory()) continue;
    strayRemoved++;
    if (!dryRun) unlinkSync(full);
  }

  // Regenerate the Makefile with the fixed template (multi-main override).
  const mk = generateJulietMakefile(caseDir, testcaseBasenames);
  if (!dryRun) writeFileSync(join(caseDir, 'Makefile'), mk);
  repaired++;

  if (c.build_command !== JULIET_BUILD_COMMAND) {
    c.build_command = JULIET_BUILD_COMMAND;
    manifestPatched++;
  }
}

if (!dryRun) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log(
  `${dryRun ? '[dry-run] ' : ''}Repaired ${repaired} case Makefiles · removed ${strayRemoved} stray artifact(s) · ` +
    `patched build_command on ${manifestPatched} case(s) in ${manifestPath}`,
);
