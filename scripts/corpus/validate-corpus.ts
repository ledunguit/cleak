#!/usr/bin/env bun
/**
 * Corpus integrity validator — the post-ingest gate that makes benchmark numbers
 * trustworthy. A defect in the INPUT data (e.g. Juliet C++ cases whose synthetic
 * headers don't compile, or a label that points at a function the source doesn't
 * contain) silently skews every Precision/Recall/F1 downstream. Five gates, split
 * into HARD (break a case → quarantine + exit 1) and SOFT (label imprecision the
 * scorer's naming-convention fallback rescues → warn, don't quarantine):
 *
 *   (a) schema       — corpus_manifest.json validates against the zod v2 schema   [HARD]
 *   (b) structural   — case dir exists; local `#include "…"` resolve (flat cases)  [HARD]
 *   (c) compile      — each buildable TU passes `clang -fsyntax-only` (catches the
 *                      C++ redefinition); a COMPILE error = corpus defect          [HARD]
 *   (d) label-overlap— a function labeled BOTH flaw and clean (contradiction)      [HARD]
 *   (d') label-drift — flaw/clean function not found in source, or flaw line not at
 *                      an allocation (Juliet scores via the good/bad naming
 *                      convention, so this is imprecision, not a wrong score)      [SOFT]
 *   (e) content-hash — sha256 over ALL case source files (the corpus's true identity)
 *
 *   bun scripts/corpus/validate-corpus.ts --corpus demo/juliet_cwe401
 *   bun scripts/corpus/validate-corpus.ts --corpus demo/lamed --skip-compile --strict-labels
 *
 * `--strict-labels` promotes label-drift to HARD — for label-authoritative corpora
 * (LAMeD / real projects) where there is NO naming convention to fall back on.
 */
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { safeParseManifest } from '@cleak/common';

const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (n: string) => process.argv.includes(`--${n}`);

const corpusDir = arg('corpus') ?? 'demo/juliet_cwe401';
const reportOnly = has('report-only');
const skipCompile = has('skip-compile');
const strictLabels = has('strict-labels');
const flatFileLimit = arg('flat-file-limit') ? parseInt(arg('flat-file-limit')!, 10) : 25;

const SRC_EXT = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx']);
const ALLOC_LIST = ['malloc', 'calloc', 'realloc', 'strdup', 'strndup', 'new'];
const ALLOC_RE = /\b(malloc|calloc|realloc|strdup|strndup|xmalloc|xcalloc|new\b)/;
const INCLUDE_RE = /^\s*#\s*include\s+"([^"]+)"/gm;

interface CaseReport {
  id: string;
  hard: string[]; // quarantine reasons
  soft: string[]; // warnings (rescued by naming convention)
}

function readFileSafe(f: string): string | null {
  try {
    return readFileSync(f, 'utf-8');
  } catch {
    return null;
  }
}

function listSourceFiles(dir: string): string[] {
  let out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out = out.concat(listSourceFiles(full));
    else if (SRC_EXT.has(extname(e).toLowerCase())) out.push(full);
  }
  return out;
}

/** clang -fsyntax-only per TU; returns COMPILE errors only (parse/semantic), no link. */
function syntaxCheck(file: string, caseDir: string): string[] {
  const isCpp = /\.(cc|cpp|cxx)$/i.test(file);
  const bin = isCpp ? 'clang++' : 'clang';
  const std = isCpp ? ['-std=c++14'] : [];
  const r = spawnSync(bin, ['-fsyntax-only', '-w', ...std, `-I${caseDir}`, file], { encoding: 'utf-8', timeout: 60_000 });
  if (r.error) return ['__compiler_unavailable__'];
  if (r.status === 0) return [];
  return `${r.stdout || ''}${r.stderr || ''}`
    .split('\n')
    .filter((l) => / error: /.test(l))
    .slice(0, 4)
    .map((l) => l.trim());
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

function identifierPresent(text: string, name: string): boolean {
  if (!name) return true; // file-level flaw (empty function) — nothing to find
  const bare = name.replace(/\(.*$/, '').split('::').pop()!.trim().replace(/[^\w]/g, '');
  if (!bare) return true;
  return new RegExp(`\\b${bare}\\b`).test(text);
}

// ── (a) schema ──────────────────────────────────────────────────────────────
const manifestPath = join(corpusDir, 'corpus_manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`✗ no corpus_manifest.json in ${corpusDir}`);
  process.exit(1);
}
const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const parsed = safeParseManifest(raw);
const schemaErrors = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
const manifest = parsed.success ? parsed.data : raw;
const cases: any[] = (manifest as any).cases ?? [];
const corpusAllocators: string[] = (manifest as any).allocators ?? [];

console.log(
  `Validating ${corpusDir} — ${cases.length} case(s)` +
    `${skipCompile ? ' [compile gate OFF]' : ''}${strictLabels ? ' [strict labels]' : ''}\n`,
);

// ── per-case gates (b)(c)(d) + content-hash parts (e) ───────────────────────
let compilerMissing = false;
const reports: CaseReport[] = [];
const hashParts: string[] = [];

for (const c of cases) {
  const caseDir = join(corpusDir, c.repo_path);
  const rep: CaseReport = { id: c.id, hard: [], soft: [] };

  if (!existsSync(caseDir)) {
    rep.hard.push('case directory missing');
    reports.push(rep);
    continue;
  }

  const files = listSourceFiles(caseDir).sort();
  const localNames = new Set(files.map((f) => basename(f)));
  for (const f of files) {
    const buf = (() => {
      try {
        return readFileSync(f);
      } catch {
        return null;
      }
    })();
    if (buf) hashParts.push(`${c.id}/${basename(f)}:${sha256(buf)}`);
  }

  // (b) structural — local include resolution for flat testcases
  if (files.length <= flatFileLimit) {
    const unresolved = new Set<string>();
    for (const f of files) {
      const txt = readFileSafe(f);
      if (txt === null) continue;
      for (const m of txt.matchAll(INCLUDE_RE)) if (!localNames.has(basename(m[1]))) unresolved.add(m[1]);
    }
    if (unresolved.size) rep.hard.push(`unresolved local include(s): ${[...unresolved].join(', ')}`);
  }

  // (c) compile — syntax-only per buildable TU
  if (!skipCompile && c.build_command) {
    for (const tu of files.filter((f) => /\.(c|cc|cpp|cxx)$/i.test(f))) {
      const errs = syntaxCheck(tu, caseDir);
      if (errs[0] === '__compiler_unavailable__') {
        if (!compilerMissing) console.warn('⚠ clang not available — compile gate skipped');
        compilerMissing = true;
        break;
      }
      if (errs.length) rep.hard.push(`compile ${basename(tu)}: ${errs[0]}`);
    }
  }

  // (d) labels — overlap is HARD (contradiction); missing/imprecise is SOFT (or HARD with --strict-labels)
  const allText = files.map((f) => readFileSafe(f) ?? '').join('\n');
  const flawFns: string[] = (c.flaws ?? []).map((x: any) => x.function).filter(Boolean);
  const cleanFns: string[] = (c.clean ?? []).map((x: any) => x.function).filter(Boolean);
  const overlap = flawFns.filter((f) => cleanFns.includes(f));
  if (overlap.length) rep.hard.push(`function(s) labeled BOTH flaw and clean: ${overlap.join(', ')}`);

  const labelDrift: string[] = [];
  for (const fn of [...flawFns, ...cleanFns]) if (!identifierPresent(allText, fn)) labelDrift.push(`label '${fn}' not in source`);
  const allocSet = new Set([...ALLOC_LIST, ...corpusAllocators, ...(c.allocators ?? [])]);
  for (const flaw of c.flaws ?? []) {
    if (flaw.line && flaw.file) {
      const ff = files.find((f) => basename(f) === basename(flaw.file));
      if (ff) {
        const near = (readFileSafe(ff) ?? '').split('\n').slice(Math.max(0, flaw.line - 4), flaw.line + 3).join('\n');
        if (!(ALLOC_RE.test(near) || [...allocSet].some((a) => near.includes(a)))) labelDrift.push(`flaw line ${flaw.file}:${flaw.line} not at an allocation`);
      }
    }
  }
  if (labelDrift.length) (strictLabels ? rep.hard : rep.soft).push(...labelDrift);

  reports.push(rep);
}

// ── (e) content-hash + report ───────────────────────────────────────────────
const contentHash = sha256(Buffer.from(hashParts.sort().join('\n'))).slice(0, 32);
const quarantined = reports.filter((r) => r.hard.length);
const warned = reports.filter((r) => !r.hard.length && r.soft.length);

const summary = {
  corpus: corpusDir,
  totalCases: cases.length,
  schemaOk: schemaErrors.length === 0,
  schemaErrors,
  quarantined: quarantined.length,
  warned: warned.length,
  clean: reports.length - quarantined.length - warned.length,
  compileGate: skipCompile || compilerMissing ? 'off' : 'on',
  strictLabels,
  contentHash,
};

const report = {
  summary,
  quarantined: quarantined.map((r) => ({ id: r.id, hard: r.hard })),
  warned: warned.map((r) => ({ id: r.id, soft: r.soft })),
};
writeFileSync(join(corpusDir, 'corpus_validation_report.json'), JSON.stringify(report, null, 2));
const md = renderMd(summary, quarantined, warned);
writeFileSync(join(corpusDir, 'corpus_validation_report.md'), md);
console.log(md);
console.log(`\ncontent-hash: ${contentHash}\n✓ report → ${corpusDir}/corpus_validation_report.{json,md}`);

const hardFail = !summary.schemaOk || summary.quarantined > 0;
if (hardFail && !reportOnly) {
  console.error(`\n✗ VALIDATION FAILED — ${quarantined.length} case(s) quarantined (HARD). Re-ingest / fix the corpus.`);
  process.exit(1);
}
console.log(hardFail ? '\n(report-only)' : '\n✓ corpus clean (no HARD failures)');

function renderMd(s: typeof summary, q: CaseReport[], w: CaseReport[]): string {
  const lines = [
    `# Corpus validation — ${s.corpus}`,
    '',
    `- cases: **${s.totalCases}** · clean ${s.clean} · **quarantined(HARD) ${s.quarantined}** · warned(SOFT) ${s.warned}`,
    `- schema: ${s.schemaOk ? '✅' : `❌ ${s.schemaErrors.length} error(s)`} · compile gate: ${s.compileGate} · strict-labels: ${s.strictLabels}`,
    `- content-hash: \`${s.contentHash}\``,
    '',
  ];
  if (s.schemaErrors.length) lines.push('## schema errors', ...s.schemaErrors.slice(0, 20).map((e) => `- ${e}`), '');
  if (q.length) {
    lines.push(`## quarantined — HARD (first 25 of ${q.length})`);
    for (const r of q.slice(0, 25)) lines.push(`- \`${r.id}\` — ${r.hard[0]}`);
  }
  if (w.length) {
    lines.push('', `## warned — SOFT label drift (first 15 of ${w.length}; rescued by naming convention)`);
    for (const r of w.slice(0, 15)) lines.push(`- \`${r.id}\` — ${r.soft[0]}`);
  }
  return lines.join('\n');
}
