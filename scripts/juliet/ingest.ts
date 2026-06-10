#!/usr/bin/env bun
/**
 * Ingest the NIST Juliet C/C++ CWE-401 (memory-leak) testcases into a v2 labeled
 * corpus the eval harness understands. Each Juliet testcase ships a `..._bad()`
 * function (the flaw, marked with a FLAW comment) and `goodG2B`/`goodB2G`
 * functions (clean) — that naming convention IS the ground truth. We group the
 * testcase's file(s), derive flaw/clean functions + flow/functional variant,
 * materialize each testcase into its own dir (so it can be scanned in
 * isolation), and emit a corpus_manifest.json (schema v2).
 *
 * Download Juliet first (public domain — see scripts/juliet/README.md):
 *   https://samate.nist.gov/SARD/downloads/test-suites/2017-10-01-juliet-test-suite-for-c-cplusplus-v1-3.zip
 *
 * Usage:
 *   bun scripts/juliet/ingest.ts --juliet <extracted-root> --out demo/juliet_cwe401 [--limit N] [--variant malloc]
 */

import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const julietRoot = arg('juliet');
const outDir = arg('out') ?? 'demo/juliet_cwe401';
const limit = arg('limit') ? parseInt(arg('limit')!, 10) : Infinity;
const variantFilter = arg('variant'); // e.g. "malloc" to ingest only malloc cases

if (!julietRoot) {
  console.error('usage: bun scripts/juliet/ingest.ts --juliet <extracted-root> --out <dir> [--limit N] [--variant <substr>]');
  process.exit(2);
}

/** Recursively collect files whose name starts with CWE401. */
function findCwe401Files(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(full);
      else if (/^CWE401_.*\.(c|cpp)$/i.test(e)) out.push(full);
    }
  };
  visit(root);
  return out;
}

// Group files into testcases: strip a trailing multi-file letter (…01a.c / …01b.c → base …01).
const BASE_RE = /^(.*_\d{2})([a-z])?\.(c|cpp)$/i;

interface Testcase {
  id: string;
  base: string;
  files: string[];
  flowVariant: string;
  functionalVariant: string;
}

const byBase = new Map<string, Testcase>();
for (const file of findCwe401Files(julietRoot)) {
  const name = basename(file);
  const m = BASE_RE.exec(name);
  const base = m ? m[1] : name.replace(/\.(c|cpp)$/i, '');
  if (variantFilter && !base.toLowerCase().includes(variantFilter.toLowerCase())) continue;
  const flow = /_(\d{2})$/.exec(base)?.[1] ?? '00';
  const func = /__([a-z]+)/i.exec(base)?.[1] ?? 'unknown'; // malloc / calloc / realloc / new / …
  const id = base.replace(/[^A-Za-z0-9_]/g, '_');
  if (!byBase.has(base)) byBase.set(base, { id, base, files: [], flowVariant: flow, functionalVariant: func, });
  byBase.get(base)!.files.push(file);
}

const testcases = [...byBase.values()].sort((a, b) => a.base.localeCompare(b.base)).slice(0, limit);
console.log(`Found ${byBase.size} CWE-401 testcase(s); ingesting ${testcases.length}.`);

const FLAW_RE = /\/\*\s*(POTENTIAL\s+)?FLAW/i;

const cases = testcases.map((tc) => {
  const caseDir = join(outDir, 'cases', tc.id);
  mkdirSync(caseDir, { recursive: true });
  let flawLine: number | undefined;
  let flawFile: string | undefined;
  for (const f of tc.files) {
    copyFileSync(f, join(caseDir, basename(f)));
    if (flawLine === undefined) {
      const lines = readFileSync(f, 'utf-8').split('\n');
      const idx = lines.findIndex((l) => FLAW_RE.test(l));
      if (idx >= 0) {
        flawLine = idx + 1;
        flawFile = basename(f);
      }
    }
  }
  return {
    id: tc.id,
    repo_path: join('cases', tc.id),
    cwe: 'CWE-401',
    flowVariant: tc.flowVariant,
    functionalVariant: tc.functionalVariant,
    flaws: [{ function: `${tc.base}_bad`, ...(flawFile ? { file: flawFile } : {}), ...(flawLine ? { line: flawLine } : {}), cwe: 'CWE-401' }],
    clean: [{ function: 'goodG2B' }, { function: 'goodB2G' }],
  };
});

const manifest = {
  schema_version: 'memory-leak-corpus/v2',
  name: 'juliet-cwe401',
  source: 'NIST Juliet C/C++ v1.3 (public domain)',
  cases,
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'corpus_manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`✓ wrote ${join(outDir, 'corpus_manifest.json')} with ${cases.length} cases`);
console.log(`  evaluate with:  bun apps/leak-inspector-tui/src/cli.ts eval --corpus ${outDir} --mode no_llm`);
