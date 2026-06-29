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
import { createHash } from 'node:crypto';

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

/**
 * Recursively collect a testcase's files. Includes `.h` — Juliet's multi-file C++
 * "class/virtual-method" variants (`_8x`) ship a per-testcase `CWE401_..._NN.h` that
 * the `.cpp` `#include`. The old filter matched only `.c/.cpp`, so re-ingesting those
 * cases dropped the header → the case either failed to compile (`file not found`) or,
 * with a stale synthetic header lying around, hit a `redefinition`. Collecting `.h`
 * keeps each C++ case self-contained + buildable.
 */
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
      else if (/^CWE401_.*\.(c|cpp|h)$/i.test(e)) out.push(full);
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

// Group a testcase's files by base = everything up to & including the flow-variant
// number `_NN`, discarding the per-file suffix. Juliet splits a testcase across:
//   …_82.h   …_82a.cpp   …_82_bad.cpp   …_82_goodG2B.cpp   …_82_goodB2G.cpp
// The old regex only stripped a SINGLE trailing letter (`[a-z]?`), so `_82_bad.cpp`
// etc. fell to the fallback and became SEPARATE case dirs — each missing the shared
// `_82.h` → unbuildable C++ cases. Strip a `_bad`/`_good…` word OR a single letter.
const BASE_RE = /^(.*_\d{2})(?:_[A-Za-z0-9]+|[a-z])?\.(c|cpp|h)$/i;

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
  const base = m ? m[1] : name.replace(/\.(c|cpp|h)$/i, '');
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
// A function DEFINITION: `name(...) {` — excludes calls (end `;`) and keeps control
// keywords out (if/while/for have no bad/good in their name, filtered below).
const FN_DEF_RE = /\b([A-Za-z_]\w*)\s*\([^;{)]*\)\s*(?:const\s*)?\{/g;

const fileSha = (p: string): string | undefined => {
  try {
    return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
  } catch {
    return undefined;
  }
};

/**
 * Derive flaw/clean function labels FROM THE SOURCE rather than hard-coding
 * `<base>_bad` + `goodG2B`/`goodB2G`. Juliet names every function with the bad/good
 * convention (`bad`, `CWE401_..._NN_bad`, `good1..9`, `goodG2B`, `goodB2GSource`, …),
 * but the hard-coded labels matched only a fraction of flow variants — the rest were
 * silently "rescued" by the scorer's naming fallback, hiding the drift. Parsing the
 * real definitions makes the manifest ground truth TRUE (and removes the dependence
 * on the fallback). C++ class variants (`_8x`) name the leak method `action` inside a
 * `<base>_bad` class — no bad-named free function — so we fall back to the class-style
 * base name to keep the case scoreable.
 */
function deriveLabels(tcFiles: string[], base: string): { flaws: any[]; clean: any[] } {
  const bad = new Set<string>();
  const good = new Set<string>();
  let flawLine: number | undefined;
  let flawFile: string | undefined;
  for (const f of tcFiles) {
    let src: string;
    try {
      src = readFileSync(f, 'utf-8');
    } catch {
      continue;
    }
    const isSrc = /\.(c|cpp)$/i.test(f);
    // C++ class variants (`_8x`): the leak lives in a method `action` of a `_bad` class
    // declared in the `.h`; no bad-named free function exists, so harvest bad/good CLASS
    // names from every file (incl. the header).
    for (const m of src.matchAll(/\bclass\s+([A-Za-z_]\w*)/g)) {
      const name = m[1];
      if (/good/i.test(name)) good.add(name);
      else if (/bad/i.test(name)) bad.add(name);
    }
    if (!isSrc) continue;
    for (const m of src.matchAll(FN_DEF_RE)) {
      const name = m[1];
      if (/good/i.test(name)) good.add(name);
      else if (/bad/i.test(name)) bad.add(name);
    }
    if (flawLine === undefined) {
      const idx = src.split('\n').findIndex((l) => FLAW_RE.test(l));
      if (idx >= 0) {
        flawLine = idx + 1;
        flawFile = basename(f);
      }
    }
  }
  if (bad.size === 0) bad.add(`${base}_bad`); // C++ class variant / unparsed — keep scoreable
  const flaws = [...bad].map((fn, i) => ({
    function: fn,
    ...(i === 0 && flawFile ? { file: flawFile, line: flawLine } : {}),
    cwe: 'CWE-401',
  }));
  const clean = [...good].map((fn) => ({ function: fn }));
  return { flaws, clean };
}

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
 * LeakSanitizer Makefile that builds BOTH the bad AND good paths and runs the
 * testcase's own main (`-DINCLUDEMAIN`). Building both (no `-DOMITGOOD`) means one
 * instrumented run exercises EVERY function — so a clean good* function is genuinely
 * `exercised_clean` (the judge can honestly exonerate it), not merely un-tested.
 * Uses LeakSanitizer ONLY (`-fsanitize=leak`): it reports at exit and never aborts
 * mid-run, so the `_bad` leak does not prevent the good path from executing. Outputs
 * `a.out` to match the dynamic analyzer's binary discovery.
 */
function makefile(hasCpp: boolean): string {
  return [
    '# Auto-generated by scripts/juliet/ingest.ts — standalone Juliet testcase.',
    '# Builds BOTH paths (good + bad), instrumented with LeakSanitizer.',
    'CC ?= clang',
    'CXX ?= clang++',
    'SAN ?= -fsanitize=leak -fno-omit-frame-pointer -g -O0',
    'DEFS ?= -DINCLUDEMAIN',
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
    '\tLSAN_OPTIONS=verbosity=1 ./a.out || true',
    '',
    'clean:',
    '\trm -f *.o a.out',
    '',
    '.PHONY: run clean',
    '',
  ].join('\n');
}

const seenIds = new Set<string>();
const cases = testcases.map((tc) => {
  if (seenIds.has(tc.id)) console.warn(`⚠ duplicate case id '${tc.id}' — files may be merged across testcases`);
  seenIds.add(tc.id);

  const caseDir = join(outDir, 'cases', tc.id);
  mkdirSync(caseDir, { recursive: true });
  // Per-file provenance: origin path + source sha256 (so the lockfile/validator can
  // prove the ingested bytes came from the verified NIST tree, not a modified source).
  const sourceFiles = tc.files.map((f) => {
    copyFileSync(f, join(caseDir, basename(f)));
    return { name: basename(f), sha256: fileSha(f) };
  });

  const hasCpp = tc.files.some((f) => /\.cpp$/i.test(f));
  const buildable = !!supportDir;
  if (buildable) {
    copySupport(caseDir, tc.files);
    writeFileSync(join(caseDir, 'Makefile'), makefile(hasCpp));
  }

  const { flaws, clean } = deriveLabels(tc.files, tc.base);

  return {
    id: tc.id,
    repo_path: join('cases', tc.id),
    cwe: 'CWE-401',
    flowVariant: tc.flowVariant,
    functionalVariant: tc.functionalVariant,
    ...(buildable ? { build_command: `make CC=clang CXX=clang++` } : {}),
    flaws,
    clean,
    _provenance: { source_root: julietRoot, files: sourceFiles },
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
