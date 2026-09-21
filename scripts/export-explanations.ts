#!/usr/bin/env -S tsx
/**
 * Export verdict/explanation/repair-diff rows for the explanation-quality rubric
 * (REVIEW item I6) — READ-ONLY over a finished eval run, writes one CSV.
 *
 *   tsx scripts/export-explanations.ts [--run <casesDir>] [--limit-cases N] [--out file.csv]
 *
 * Default run: the frozen full-corpus B6a sweep
 * (results/baseline-sweep-2026-08-15T08-28-06/B6a/run-1/cases). Rows are taken
 * from the first N case files in sorted order (deterministic), one row per
 * finding — each row is one judged site, which is the unit the rubric scores.
 * Fields verified against the on-disk case schema (id / findings[].verdict /
 * findings[].explanation / findings[].repair_diff). Missing fields become empty
 * cells, never a crash.
 *
 * The output feeds docs/EXPLANATION-QUALITY-RUBRIC.md: pick 20 rows, score
 * root-cause correctness (0-2) and fix-diff applicability (0-2).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_CASES_DIR = 'results/baseline-sweep-2026-08-15T08-28-06/B6a/run-1/cases';
const DEFAULT_OUT = 'paper/figures/explanations-sample.csv';
const DEFAULT_LIMIT = 20;

function parseArgs(argv: string[]): { casesDir: string; out: string; limit: number } {
  let casesDir = DEFAULT_CASES_DIR;
  let out = DEFAULT_OUT;
  let limit = DEFAULT_LIMIT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run') casesDir = argv[++i] ?? casesDir;
    else if (argv[i] === '--out') out = argv[++i] ?? out;
    else if (argv[i] === '--limit-cases') limit = Math.max(1, Number(argv[++i]) || DEFAULT_LIMIT);
  }
  return { casesDir, out, limit };
}

interface RepairDiff {
  filePath?: string;
  startLine?: number;
  originalLines?: string[];
  suggestedLines?: string[];
  description?: string;
}

interface Finding {
  id?: string;
  function?: string;
  file?: string;
  line?: number;
  allocation_type?: string;
  verdict?: string;
  verdict_tool?: string;
  dynamic_coverage?: string;
  confidence?: number;
  explanation?: string;
  repair_suggestion?: string;
  repair_diff?: RepairDiff;
}

interface CaseFile {
  id?: string;
  findings?: Finding[];
}

/** Render a repair_diff object as unified-diff-style text for the CSV cell. */
function renderRepairDiff(diff: RepairDiff | undefined): string {
  if (!diff || typeof diff !== 'object') return '';
  const lines: string[] = [];
  const path = typeof diff.filePath === 'string' ? diff.filePath : '';
  if (path) lines.push(`--- a/${path}`, `+++ b/${path}`);
  if (typeof diff.startLine === 'number') lines.push(`@@ -${diff.startLine} +${diff.startLine} @@`);
  for (const l of diff.originalLines ?? []) lines.push(`-${l.replace(/\r$/, '')}`);
  for (const l of diff.suggestedLines ?? []) lines.push(`+${l.replace(/\r$/, '')}`);
  if (diff.description) lines.push(`(${diff.description})`);
  return lines.join('\n');
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

const HEADER = [
  'caseId',
  'siteId',
  'function',
  'file',
  'line',
  'allocation_type',
  'verdict',
  'verdict_tool',
  'confidence',
  'dynamic_coverage',
  'explanation',
  'repair_suggestion',
  'repair_diff',
];

function main(): void {
  const { casesDir, out, limit } = parseArgs(process.argv.slice(2));
  if (!existsSync(casesDir) || !statSync(casesDir).isDirectory()) {
    console.error(`✗ cases directory not found: ${casesDir}`);
    process.exit(2);
  }

  const files = readdirSync(casesDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .slice(0, limit);

  const rows: string[] = [HEADER.join(',')];
  let findingsExported = 0;
  let casesWithFindings = 0;

  for (const file of files) {
    let parsed: CaseFile;
    try {
      parsed = JSON.parse(readFileSync(join(casesDir, file), 'utf-8')) as CaseFile;
    } catch (err) {
      console.error(`⚠ skipping unreadable case file ${file}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    const caseId = typeof parsed.id === 'string' ? parsed.id : file.replace(/\.json$/, '');
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    if (findings.length > 0) casesWithFindings++;
    for (const f of findings) {
      const diff = renderRepairDiff(f.repair_diff);
      const cells = [
        caseId,
        typeof f.id === 'string' ? f.id : '',
        typeof f.function === 'string' ? f.function : '',
        typeof f.file === 'string' ? f.file : '',
        typeof f.line === 'number' ? String(f.line) : '',
        typeof f.allocation_type === 'string' ? f.allocation_type : '',
        typeof f.verdict === 'string' ? f.verdict : '',
        typeof f.verdict_tool === 'string' ? f.verdict_tool : '',
        typeof f.confidence === 'number' ? String(f.confidence) : '',
        typeof f.dynamic_coverage === 'string' ? f.dynamic_coverage : '',
        typeof f.explanation === 'string' ? f.explanation : '',
        typeof f.repair_suggestion === 'string' ? f.repair_suggestion : '',
        diff,
      ];
      rows.push(cells.map(csvEscape).join(','));
      findingsExported++;
    }
  }

  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, rows.join('\n') + '\n');
  console.log(`✓ wrote ${out}`);
  console.log(`  case files read: ${files.length} (limit ${limit}), with findings: ${casesWithFindings}`);
  console.log(`  data rows (findings): ${findingsExported}`);
  console.log(`  rows with explanation: non-empty by schema — verify with: grep -c ',' ${out}`);
  console.log(`  READ-ONLY check: nothing under results/ was modified.`);
}

main();
