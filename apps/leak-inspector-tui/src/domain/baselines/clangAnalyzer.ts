/**
 * Clang Static Analyzer baseline (`clang --analyze`). This is the core of
 * `scan-build` WITHOUT its Perl build-interception wrapper — for single-TU Juliet
 * cases (and any case whose sources compile standalone) we invoke the analyzer
 * directly, which is far more portable (it runs wherever `clang` is installed; the
 * repo's containerized `scan-build` needs a working build + Perl env). It is the
 * GUARANTEED first-class baseline: precise but conservative, the classic foil to
 * an LLM-guided detector's recall.
 *
 * The parser (`parseClangLeaks`) is pure and unit-tested; the adapter wraps it
 * with the `clang` invocation and resolves each diagnostic's enclosing function so
 * the findings score in Juliet's function mode.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { findEnclosingFunction } from '@mcpvul/common/analysis/heuristic-leak-analysis';
import type { BaselineAdapter } from './adapter';
import type { SnapshotFinding, LabeledCase } from '../evalScoring';
import { readFileSafe } from '../fileWalk';

/** The Clang SA checkers that denote a memory LEAK (not double-free / stack-escape). */
const LEAK_CHECKERS = new Set(['unix.Malloc', 'cplusplus.NewDelete']);

/** A leak diagnostic before source-level function resolution. */
export interface ClangLeakRaw {
  /** Path exactly as clang reported it (used to read the source). */
  file: string;
  /** 1-based line of the leak warning. */
  line: number;
  /** 1-based allocation line from the `Memory is allocated` note, when present. */
  allocLine?: number;
  message: string;
  checker: string;
}

const WARNING_RE = /^(.*?):(\d+):(\d+): warning: (.+) \[([\w.]+)\]\s*$/;
const ALLOC_NOTE_RE = /^(.*?):(\d+):(\d+): note: Memory is allocated\s*$/;

/**
 * Parse `clang --analyze -analyzer-output=text` output into leak diagnostics.
 * Keeps ONLY genuine leak warnings (a `unix.Malloc`/`cplusplus.NewDelete` checker
 * whose message says "leak", excluding `…should not be deallocated`), and pairs
 * each with its allocation site from the following `Memory is allocated` note.
 * Pure (string → data) so it is unit-tested without invoking clang.
 */
export function parseClangLeaks(output: string): ClangLeakRaw[] {
  const lines = output.split('\n');
  const out: ClangLeakRaw[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(WARNING_RE);
    if (!m) continue;
    const [, file, lineStr, , message, checker] = m;
    if (!LEAK_CHECKERS.has(checker)) continue;
    if (!/leak/i.test(message)) continue;
    if (/should not be deallocated/i.test(message)) continue; // double-free, not a leak
    // Look ahead (within this diagnostic, i.e. until the next warning) for the alloc note.
    let allocLine: number | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      if (WARNING_RE.test(lines[j])) break;
      const an = lines[j].match(ALLOC_NOTE_RE);
      if (an) {
        allocLine = Number(an[2]);
        break;
      }
    }
    out.push({ file, line: Number(lineStr), allocLine, message, checker });
  }
  return out;
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'else', 'do']);

/** The name of the function enclosing a 1-based source line (Juliet function mode). */
function enclosingFunctionName(source: string, line1Based: number): string | undefined {
  const lines = source.split('\n');
  const idx = Math.min(Math.max(line1Based - 1, 0), lines.length - 1);
  const bounds = findEnclosingFunction(lines, idx);
  const sigStart = bounds ? bounds.startIdx : idx;
  // The signature is on the opening-brace line or a few lines above it. Take the
  // last non-keyword identifier immediately followed by '(' (the function name).
  for (let i = sigStart; i >= Math.max(0, sigStart - 4); i--) {
    const re = /([A-Za-z_]\w*)\s*\(/g;
    let m: RegExpExecArray | null;
    let last: string | undefined;
    while ((m = re.exec(lines[i]))) if (!KEYWORDS.has(m[1])) last = m[1];
    if (last) return last;
  }
  return undefined;
}

/** Source files clang should analyze: a case's own translation units (skip the
 * shared Juliet `io.c` I/O helper, which carries no flaws). */
function caseSourceFiles(caseDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(caseDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => /\.(c|cc|cpp|cxx)$/.test(f) && f !== 'io.c')
    .map((f) => join(caseDir, f));
}

export class ClangAnalyzerAdapter implements BaselineAdapter {
  readonly name = 'clang-analyzer';
  private readonly bin = process.env.CLANG_BIN || 'clang';

  async available(): Promise<boolean> {
    try {
      const r = spawnSync(this.bin, ['--version'], { encoding: 'utf-8', timeout: 10_000 });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  async run(caseDir: string, _c: LabeledCase): Promise<SnapshotFinding[]> {
    const findings: SnapshotFinding[] = [];
    const files = caseSourceFiles(caseDir);
    let analyzedAny = false;
    for (const file of files) {
      const r = spawnSync(
        this.bin,
        [
          '--analyze',
          '-Xclang',
          '-analyzer-output=text',
          '-Xclang',
          '-analyzer-checker=core,unix.Malloc,cplusplus.NewDelete',
          `-I${caseDir}`,
          file,
        ],
        { cwd: caseDir, encoding: 'utf-8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      );
      const output = `${r.stdout || ''}${r.stderr || ''}`;
      // A fatal error (e.g. a missing header) means the TU could not be parsed, so
      // its "no leak warning" is NOT evidence of a clean function — it's a tool
      // failure. Track analyzability so a case that NOWHERE compiled is reported as
      // an error (excluded from metrics) rather than silently scored as all-miss.
      if (!/fatal error:/i.test(output)) analyzedAny = true;
      for (const raw of parseClangLeaks(output)) {
        // Prefer the allocation line as the site (matches how the system scores
        // allocations); fall back to the warning line.
        const siteLine = raw.allocLine ?? raw.line;
        const src = readFileSafe(raw.file) ?? readFileSafe(file);
        const fn = src ? enclosingFunctionName(src, siteLine) : undefined;
        findings.push({
          function: fn,
          file: basename(raw.file),
          line: siteLine,
          verdict: 'confirmed_leak', // a clang leak warning is a positive prediction
          confidence: 0.9,
          verdict_tool: 'clang-analyzer',
        });
      }
    }
    // No TU compiled and nothing was found → we cannot claim this case is clean.
    // Throw so runBaselineEval records it as `error` (excluded), not a false miss.
    if (files.length > 0 && !analyzedAny && findings.length === 0) {
      throw new Error(`clang could not analyze any TU in ${caseDir} (fatal compile errors)`);
    }
    return findings;
  }
}
