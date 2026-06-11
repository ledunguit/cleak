#!/usr/bin/env bun
/**
 * Ingest the NIST Juliet C/C++ CWE-401 (memory-leak) testcases into a v2 labeled
 * corpus the eval harness understands — AND materialize each testcase as a
 * self-contained, buildable project so you can `cd` into one and run it
 * manually (`/scan .`, `make run`) exactly like any real C/C++ repo.
 *
 * Each Juliet testcase ships a `..._bad()` function (the flaw, marked with a
 * FLAW comment) and `goodG2B`/`goodB2G` functions (clean) — that naming
 * convention IS the ground truth. We group the testcase's file(s), derive
 * flaw/clean functions + flow/functional variant, copy the Juliet support files
 * (std_testcase.h, io.c, …) next to it, generate an ASan/LSan Makefile that
 * builds ONLY the bad path (`-DINCLUDEMAIN -DOMITGOOD`), and emit a
 * corpus_manifest.json (schema v2) with a `build_command` so the dynamic stage
 * can run.
 *
 * Download Juliet first (public domain — see scripts/juliet/README.md):
 *   https://samate.nist.gov/SARD/downloads/test-suites/2017-10-01-juliet-test-suite-for-c-cplusplus-v1-3.zip
 *
 * Usage:
 *   bun scripts/juliet/ingest.ts --juliet <extracted-root> --out demo/juliet_cwe401 \
 *       [--limit N] [--variant malloc] [--support <testcasesupport dir>] [--no-build]
 *
 *   --no-build   only copy sources (static-only corpus; no support files / Makefile)
 *   --support    override auto-detection of Juliet's testcasesupport/ directory
 */

import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const julietRoot = arg('juliet');
const outDir = arg('out') ?? 'demo/juliet_cwe401';
const limit = arg('limit') ? parseInt(arg('limit')!, 10) : Infinity;
const variantFilter = arg('variant'); // e.g. "malloc" to ingest only malloc cases
const noBuild = hasFlag('no-build');
const supportOverride = arg('support');

if (!julietRoot) {
  console.error('usage: bun scripts/juliet/ingest.ts --juliet <extracted-root> --out <dir> [--limit N] [--variant <substr>] [--support <dir>] [--no-build]');
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

/**
 * Locate Juliet's `testcasesupport/` (holds std_testcase.h, io.c, …). It sits at
 * `<juliet>/C/testcasesupport`; --juliet usually points deeper (…/testcases/
 * CWE401_Memory_Leak), so walk parents looking for a testcasesupport dir that
 * actually contains std_testcase.h.
 */
function findSupportDir(start: string): string | undefined {
  if (supportOverride) return existsSync(join(supportOverride, 'std_testcase.h')) ? supportOverride : undefined;
  let dir = start;
  for (let i = 0; i < 8; i++) {
    for (const cand of [join(dir, 'testcasesupport'), join(dir, 'C', 'testcasesupport')]) {
      if (existsSync(join(cand, 'std_testcase.h'))) return cand;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
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

const supportDir = noBuild ? undefined : findSupportDir(julietRoot);
if (!noBuild && !supportDir) {
  console.warn('⚠ testcasesupport/ not found (pass --support <dir>). Emitting static-only projects (no Makefile / build_command).');
}
console.log(`Found ${byBase.size} CWE-401 testcase(s); ingesting ${testcases.length}${supportDir ? ' as buildable projects' : ' (static-only)'}.`);

const FLAW_RE = /\/\*\s*(POTENTIAL\s+)?FLAW/i;
// Core Juliet C support files every CWE-401 testcase needs to compile + run.
const CORE_SUPPORT = ['std_testcase.h', 'std_testcase_io.h', 'io.c'];
const INCLUDE_RE = /#\s*include\s+"([^"]+)"/g;

/** Copy the support files a project needs: the core set + any local headers it #includes. */
function copySupport(caseDir: string, tcFiles: string[]): void {
  if (!supportDir) return;
  const wanted = new Set(CORE_SUPPORT);
  for (const f of tcFiles) {
    let src = '';
    try {
      src = readFileSync(f, 'utf-8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(INCLUDE_RE)) wanted.add(m[1]);
  }
  for (const name of wanted) {
    const from = join(supportDir, name);
    if (existsSync(from)) {
      try {
        copyFileSync(from, join(caseDir, basename(name)));
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * ASan/LSan Makefile that builds ONLY the bad path (`-DOMITGOOD`) and runs the
 * testcase's own main (`-DINCLUDEMAIN`). The good* functions stay in the source
 * (so static analysis still scores them as negatives) but are compiled out, so a
 * LeakSanitizer hit is unambiguously the `_bad` flaw. Outputs `a.out` to match
 * the dynamic analyzer's binary discovery.
 */
function makefile(hasCpp: boolean): string {
  return [
    '# Auto-generated by scripts/juliet/ingest.ts — standalone Juliet testcase.',
    '# Builds the BAD path only, instrumented with AddressSanitizer + LeakSanitizer.',
    'CC ?= clang',
    'CXX ?= clang++',
    'SAN ?= -fsanitize=address -fno-omit-frame-pointer -g -O0',
    'DEFS ?= -DINCLUDEMAIN -DOMITGOOD',
    'INC ?= -I.',
    'CSRC := $(wildcard *.c)',
    'CPPSRC := $(wildcard *.cpp)',
    'COBJ := $(CSRC:.c=.o)',
    'CPPOBJ := $(CPPSRC:.cpp=.o)',
    `LINK := ${hasCpp ? '$(CXX)' : '$(CC)'}`,
    '',
    'a.out: $(COBJ) $(CPPOBJ)',
    '\t$(LINK) $(SAN) $(COBJ) $(CPPOBJ) -o a.out',
    '',
    '%.o: %.c',
    '\t$(CC) $(SAN) $(DEFS) $(INC) -c $< -o $@',
    '',
    '%.o: %.cpp',
    '\t$(CXX) $(SAN) $(DEFS) $(INC) -c $< -o $@',
    '',
    'run: a.out',
    '\tASAN_OPTIONS=detect_leaks=1 LSAN_OPTIONS=verbosity=1 ./a.out || true',
    '',
    'clean:',
    '\trm -f *.o a.out',
    '',
    '.PHONY: run clean',
    '',
  ].join('\n');
}

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

  const hasCpp = tc.files.some((f) => /\.cpp$/i.test(f));
  const buildable = !!supportDir;
  if (buildable) {
    copySupport(caseDir, tc.files);
    writeFileSync(join(caseDir, 'Makefile'), makefile(hasCpp));
  }

  return {
    id: tc.id,
    repo_path: join('cases', tc.id),
    cwe: 'CWE-401',
    flowVariant: tc.flowVariant,
    functionalVariant: tc.functionalVariant,
    ...(buildable ? { build_command: `make CC=clang CXX=clang++` } : {}),
    flaws: [{ function: `${tc.base}_bad`, ...(flawFile ? { file: flawFile } : {}), ...(flawLine ? { line: flawLine } : {}), cwe: 'CWE-401' }],
    clean: [{ function: 'goodG2B' }, { function: 'goodB2G' }],
  };
});

const manifest = {
  schema_version: 'memory-leak-corpus/v2',
  name: 'juliet-cwe401',
  source: 'NIST Juliet C/C++ v1.3 (public domain)',
  buildable: !!supportDir,
  cases,
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'corpus_manifest.json'), JSON.stringify(manifest, null, 2));

const sample = cases[0]?.id;
console.log(`✓ wrote ${join(outDir, 'corpus_manifest.json')} with ${cases.length} cases`);
if (supportDir) {
  console.log(`  support files from: ${supportDir}`);
  console.log('');
  console.log('Try ONE sample by hand (project is self-contained):');
  console.log(`  cd ${join(outDir, 'cases', sample ?? '<id>')}`);
  console.log('  make run                 # build + run the bad path under ASan/LeakSanitizer');
  console.log('  leak-tui scan . --dynamic selective   # or your /scan workflow (static + dynamic)');
  console.log('');
  console.log('Batch-evaluate the whole set:');
  console.log(`  leak-tui eval --corpus ${outDir} --mode no_llm --dynamic selective --concurrency 6`);
} else {
  console.log(`  evaluate with:  leak-tui eval --corpus ${outDir} --mode no_llm`);
}
