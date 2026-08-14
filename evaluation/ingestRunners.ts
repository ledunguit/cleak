/**
 * Thin wrappers that shell out to the existing ingest/validate scripts, streaming
 * their own console output live. `scripts/juliet/ingest.ts` has unconditional
 * top-level `process.exit(2)` if `--juliet` is missing, so it's unsafe to import
 * directly; `scripts/lamed/ingest.ts` / `scripts/memhint/ingest.ts` guard their
 * `main()` and could technically be imported, but shelling out to all three
 * uniformly keeps one consistent streaming/error-handling code path here.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function runTsx(args: string[]): void {
  execFileSync('pnpm', ['exec', 'tsx', ...args], { stdio: 'inherit' });
}

export function runJulietIngest(extractedRoot: string, outDir: string): void {
  runTsx(['scripts/juliet/ingest.ts', '--juliet', extractedRoot, '--out', outDir]);
}

export function runLamedIngest(outDir: string): void {
  runTsx(['scripts/lamed/ingest.ts', '--out', outDir]);
}

export function runMemhintIngest(outDir: string): void {
  runTsx(['scripts/memhint/ingest.ts', '--out', outDir]);
}

/**
 * Validate + write the trust lockfile a fresh ingest needs before `checkCorpusGate`
 * will pass. LAMeD/MemHint are real, multi-file projects (autotools/CMake) whose
 * per-file `clang -fsyntax-only` gate is documented (docs/DATASETS.md) as the wrong
 * tool — pass `skipCompile`; they're also label-authoritative (positive-only, no
 * Juliet-style naming-convention fallback) — pass `strictLabels`. Juliet keeps
 * neither (its locked-in compile-gate + soft-label-drift behavior).
 */
export function runValidateAndLock(outDir: string, opts: { strictLabels?: boolean; skipCompile?: boolean } = {}): void {
  const args = ['scripts/corpus/validate-corpus.ts', '--corpus', outDir, '--write-lock', `${outDir}.lock.json`];
  if (opts.strictLabels) args.push('--strict-labels');
  if (opts.skipCompile) args.push('--skip-compile');
  runTsx(args);
}

export function extractZip(zipPath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { stdio: 'inherit' });
}

/** Streams a `curl` download — used only when the user explicitly opts in to
 * auto-downloading the Juliet NIST zip (default off, see wizard.ts). */
export function downloadFile(url: string, destPath: string): void {
  mkdirSync(dirname(destPath), { recursive: true });
  execFileSync('curl', ['-L', '--fail', '-o', destPath, url], { stdio: 'inherit' });
}
