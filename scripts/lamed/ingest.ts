#!/usr/bin/env bun
/**
 * Ingest the LAMeD memory-leak benchmark into a v2 labeled corpus the eval harness
 * understands, so leak-investigator can be run head-to-head on the only
 * peer-reviewed C/C++ leak benchmark (LAMeD, EASE'25).
 *
 * Source of truth: `demo/lamed/memleak_benchmark.json` (committed; from Zenodo
 * record 15089703, DOI 10.5281/zenodo.15089703, BSD-3). It is POSITIVE-ONLY and
 * FUNCTION-LEVEL — 41 developer-confirmed leaks across 7 C projects, each entry:
 *   { project, bug_repo_link, file, target_function, commit, fixed_repo_link, id }
 * There are no line numbers, no CWE field, and no negative (clean) labels; the
 * leaking state is the tree at `bug_repo_link`.
 *
 * Mapping → LabeledCase (see apps/leak-inspector-tui/src/domain/evalScoring.ts):
 *   - one case per entry; `flaws[]` = one per function in `target_function`
 *     (split on `;`, bare name extracted from the C signature), `cwe: CWE-401`,
 *     `line` omitted (LAMeD has none); `clean[]` empty (positive-only).
 *   - `repo_path` = the materialized source tree checked out at the bug commit.
 *
 * Because LAMeD is positive-only, scoring on it reports RECALL and FP COUNT (the
 * LAMeD-style headline), not specificity/MCC — same fairness rule as the
 * positive-only static baselines (see docs/BASELINE-COMPARISON.md).
 *
 * Usage:
 *   bun scripts/lamed/ingest.ts                          # materialize (clones repos)
 *   bun scripts/lamed/ingest.ts --manifest-only          # write the manifest only (no clone)
 *   bun scripts/lamed/ingest.ts --benchmark <path> --out demo/lamed --clones /tmp/lamed-clones
 *
 * The pure mapping helpers are exported (and unit-tested in ingest.test.ts);
 * execution is guarded by `import.meta.main` so importing them runs nothing.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface LamedEntry {
  project: string;
  bug_repo_link: string;
  file: string;
  target_function: string;
  commit: string;
  fixed_repo_link: string;
  id: string;
}

export interface LabeledFlaw {
  file: string;
  function: string;
  cwe: string;
}

// ── Pure mapping helpers (unit-tested) ──────────────────────────────────────

/** `https://github.com/{org}/{repo}/(tree|commit)/{sha}` → {repoUrl, sha}. */
export function parseGithubRef(url: string): { repoUrl: string; sha: string } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/(?:tree|commit)\/([0-9a-f]+)/i);
  if (!m) return null;
  return { repoUrl: `https://github.com/${m[1]}/${m[2]}.git`, sha: m[3] };
}

/**
 * Bare function name from a (possibly truncated) C signature. The function name is
 * the identifier before its `(`; LAMeD signatures often start with an ALL-CAPS
 * return-type macro (`CJSON_PUBLIC(char *) realFn(...)`), so we take the FIRST
 * callee that contains a lowercase letter (skipping the macro), then fall back to
 * the first callee, then the last identifier (e.g. a bare `main`).
 */
export function bareFunctionName(sig: string): string {
  const calls = [...sig.matchAll(/([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]);
  const nonMacro = calls.filter((n) => /[a-z]/.test(n));
  if (nonMacro.length) return nonMacro[0];
  if (calls.length) return calls[0];
  const ids = sig.match(/[A-Za-z_]\w*/g);
  return ids ? ids[ids.length - 1] : sig.trim();
}

/**
 * Split on TOP-LEVEL `;` only. LAMeD overloads `;` as BOTH a parameter separator
 * (inside the signature's parens) AND a multi-function separator (`main; static
 * void f(void)`), and truncates mid-signature — so a depth-aware split is required
 * to avoid slicing a parameter list into bogus "functions".
 */
export function splitTopLevelSemicolons(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** `target_function` → de-duplicated bare function names (drops empties). */
export function functionsOf(targetFunction: string): string[] {
  const names = splitTopLevelSemicolons(targetFunction ?? '')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(bareFunctionName)
    .filter(Boolean);
  return [...new Set(names)];
}

/**
 * Flaws for one entry. With function labels → one flaw per function; with an empty
 * `target_function` (6 of the 41 entries) → a single file-level flaw with an empty
 * function (scoreable only in line mode, which LAMeD lacks — recorded honestly,
 * flagged via `fileLevelOnly`, rather than dropped).
 */
export function entryToFlaws(e: LamedEntry): { flaws: LabeledFlaw[]; fileLevelOnly: boolean } {
  const fns = functionsOf(e.target_function);
  if (fns.length === 0) {
    return { flaws: [{ file: e.file, function: '', cwe: 'CWE-401' }], fileLevelOnly: true };
  }
  return { flaws: fns.map((fn) => ({ file: e.file, function: fn, cwe: 'CWE-401' })), fileLevelOnly: false };
}

// ── Side-effecting helpers (materialization) ────────────────────────────────

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024 });
}

/** Clone a repo once (full history so any SHA resolves), cached under clonesDir. */
function ensureClone(project: string, repoUrl: string, clonesDir: string): string {
  const dir = join(clonesDir, project);
  if (existsSync(join(dir, '.git'))) return dir;
  mkdirSync(clonesDir, { recursive: true });
  console.log(`  cloning ${repoUrl} → ${dir}`);
  execFileSync('git', ['clone', '--filter=blob:none', repoUrl, dir], { stdio: 'inherit' });
  return dir;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function main(): void {
  const benchmarkPath = resolve(arg('benchmark', 'demo/lamed/memleak_benchmark.json')!);
  const outDir = resolve(arg('out', 'demo/lamed')!);
  const clonesDir = resolve(arg('clones', join(outDir, '.clones'))!);
  const manifestOnly = has('manifest-only');
  const onlyProject = arg('project'); // materialize/emit a single project (e.g. cjson)

  const all = Object.values(JSON.parse(readFileSync(benchmarkPath, 'utf-8')) as Record<string, LamedEntry>);
  const entries = onlyProject ? all.filter((e) => e.project === onlyProject) : all;
  console.log(`LAMeD: ${entries.length}${onlyProject ? `/${all.length} (project=${onlyProject})` : ''} leak entries from ${benchmarkPath}`);

  const cases: any[] = [];
  let fileLevelOnly = 0;
  let materialized = 0;
  const skipped: string[] = [];

  for (const e of entries) {
    const ref = parseGithubRef(e.bug_repo_link) ?? parseGithubRef(e.commit);
    const { flaws, fileLevelOnly: isFileLevel } = entryToFlaws(e);
    if (isFileLevel) fileLevelOnly++;

    const caseDir = join(outDir, 'cases', e.id);
    if (!manifestOnly) {
      if (!ref) {
        skipped.push(`${e.id} (unparseable repo ref)`);
        continue;
      }
      try {
        const clone = ensureClone(e.project, ref.repoUrl, clonesDir);
        git(clone, ['checkout', '--quiet', ref.sha]);
        rmSync(caseDir, { recursive: true, force: true });
        mkdirSync(caseDir, { recursive: true });
        // Copy the working tree (sans .git) to a stable, per-case snapshot.
        cpSync(clone, caseDir, { recursive: true, filter: (src) => !src.includes(`${clone}/.git`) });
        materialized++;
      } catch (err: any) {
        skipped.push(`${e.id} (${String(err?.message ?? err).slice(0, 80)})`);
        continue;
      }
    }

    cases.push({
      id: e.id,
      repo_path: caseDir,
      flaws,
      clean: [],
      cwe: 'CWE-401',
      functionalVariant: e.project,
      // Provenance (not read by the scorer, but keeps the label traceable to LAMeD).
      _lamed: { bugRef: e.bug_repo_link, fixCommit: e.commit, file: e.file, targetFunction: e.target_function },
    });
  }

  const manifest = {
    schema_version: 'memory-leak-corpus/v2',
    name: 'lamed-memleak-benchmark',
    source: 'LAMeD (EASE 2025) — Zenodo 10.5281/zenodo.15089703, BSD-3',
    positive_only: true,
    cases,
  };
  mkdirSync(outDir, { recursive: true });
  const manifestPath = join(outDir, 'corpus_manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\nwrote ${cases.length} cases → ${manifestPath}`);
  console.log(`  flaws total       : ${cases.reduce((n, c) => n + c.flaws.length, 0)}`);
  console.log(`  file-level-only   : ${fileLevelOnly} (empty target_function — unscoreable in function mode)`);
  if (!manifestOnly) console.log(`  materialized      : ${materialized}/${entries.length} case source trees`);
  else console.log(`  (manifest-only: repo_path points at cases/<id>; run without --manifest-only to clone + materialize)`);
  if (skipped.length) console.log(`  skipped           : ${skipped.length}\n    - ${skipped.slice(0, 10).join('\n    - ')}`);
  console.log('\nLAMeD is POSITIVE-ONLY → score RECALL + FP count (not specificity/MCC). See docs/BASELINE-COMPARISON.md.');
}

if (import.meta.main) main();
