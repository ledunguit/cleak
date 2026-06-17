/**
 * Facebook/Meta Infer baseline (best-effort, gated on availability). Infer needs
 * to intercept a real build, so a case must carry a `build_command`. Its
 * `report.json` lists issues with a `bug_type`; we keep the memory-leak types and
 * normalize them to `SnapshotFinding[]`. Not installed in every environment —
 * `available()` gates it so it is cleanly skipped (and cited from the literature)
 * rather than faked.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BaselineAdapter } from './adapter';
import type { SnapshotFinding, LabeledCase } from '../evalScoring';
import { readFileSafe } from '../fileWalk';

/** Infer bug types that denote a memory leak (incl. the Pulse backend's variants). */
const LEAK_BUG_TYPES = new Set([
  'MEMORY_LEAK',
  'MEMORY_LEAK_C',
  'MEMORY_LEAK_CPP',
  'PULSE_MEMORY_LEAK',
  'PULSE_MEMORY_LEAK_C',
  'PULSE_MEMORY_LEAK_CPP',
]);

interface InferIssue {
  bug_type?: string;
  file?: string;
  line?: number;
  procedure?: string;
}

/** Normalize an Infer `report.json` (parsed) to leak findings. Pure / testable. */
export function parseInferLeaks(report: unknown): SnapshotFinding[] {
  if (!Array.isArray(report)) return [];
  const out: SnapshotFinding[] = [];
  for (const raw of report as InferIssue[]) {
    if (!raw || !raw.bug_type || !LEAK_BUG_TYPES.has(raw.bug_type)) continue;
    out.push({
      function: raw.procedure,
      file: raw.file ? basename(raw.file) : undefined,
      line: typeof raw.line === 'number' ? raw.line : undefined,
      verdict: 'confirmed_leak',
      confidence: 0.9,
      verdict_tool: 'infer',
    });
  }
  return out;
}

export class InferAdapter implements BaselineAdapter {
  readonly name = 'infer';
  private readonly bin = process.env.INFER_BIN || 'infer';

  async available(): Promise<boolean> {
    try {
      const r = spawnSync(this.bin, ['--version'], { encoding: 'utf-8', timeout: 10_000 });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  async run(caseDir: string, c: LabeledCase): Promise<SnapshotFinding[]> {
    if (!c.build_command) return []; // Infer must intercept a real build
    // Results go to an OS temp dir (cleaned up below), never the corpus case dir,
    // so a comparison run leaves no `infer-out` artifacts behind.
    const outDir = mkdtempSync(join(tmpdir(), 'infer-baseline-'));
    try {
      const r = spawnSync(
        this.bin,
        ['run', '--results-dir', outDir, '--keep-going', '--', '/bin/sh', '-c', c.build_command],
        { cwd: caseDir, encoding: 'utf-8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
      );
      const reportRaw = readFileSafe(join(outDir, 'report.json'));
      // A successful infer run ALWAYS writes report.json (an empty array when it
      // finds nothing). A missing report means infer itself failed — surface that
      // as an error (the case is excluded) rather than silently scoring it as an
      // all-miss, which would corrupt recall.
      if (!reportRaw) {
        throw new Error(`infer produced no report.json (status=${r.status}, error=${r.error?.message ?? 'none'})`);
      }
      return parseInferLeaks(JSON.parse(reportRaw));
    } finally {
      try {
        rmSync(outDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
