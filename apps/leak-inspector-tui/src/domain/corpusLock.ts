/**
 * Corpus lockfile + integrity gate. A benchmark number is only trustworthy if the
 * data it was measured on is the data we think it is. `provenance.corpusHash` used to
 * hash ONLY corpus_manifest.json — so a corrupted/synthetic SOURCE file (e.g. the
 * Juliet C++ headers that didn't compile) was invisible. This module computes a hash
 * over ALL case SOURCE files and compares it to a committed lockfile produced by
 * `scripts/corpus/validate-corpus.ts --write-lock`. The eval harness refuses to run on
 * a corpus that has no lockfile, failed validation, or drifted from its locked hash
 * (unless `--allow-unvalidated`). The hash algorithm MUST stay byte-identical to the
 * validator's.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';

const SRC_EXT = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx']);

export interface CorpusLock {
  schema: string;
  corpus: string;
  source?: { name?: string; url?: string; sha256?: string };
  ingestCommit?: string;
  toolVersions?: Record<string, string>;
  contentHash: string;
  validatedAt?: string;
  validated: boolean;
  summary?: { total: number; clean: number; warned: number; quarantined: number };
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

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/**
 * Deterministic hash over every case's source files (sorted `id/file:filesha`), the
 * corpus's true identity. MUST match `validate-corpus.ts`. Returns undefined if the
 * manifest is unreadable.
 */
export function corpusContentHash(corpusDir: string): string | undefined {
  const manifestPath = join(corpusDir, 'corpus_manifest.json');
  if (!existsSync(manifestPath)) return undefined;
  let cases: any[];
  try {
    cases = JSON.parse(readFileSync(manifestPath, 'utf-8')).cases ?? [];
  } catch {
    return undefined;
  }
  const parts: string[] = [];
  for (const c of cases) {
    const caseDir = join(corpusDir, c.repo_path);
    for (const f of listSourceFiles(caseDir)) {
      try {
        parts.push(`${c.id}/${basename(f)}:${sha256(readFileSync(f))}`);
      } catch {
        /* unreadable — its absence changes the hash, which is the point */
      }
    }
  }
  return sha256(Buffer.from(parts.sort().join('\n'))).slice(0, 32);
}

/** Read `<corpusDir>.lock.json` (sibling of the corpus dir). */
export function readCorpusLock(corpusDir: string): CorpusLock | undefined {
  const path = `${corpusDir.replace(/\/+$/, '')}.lock.json`;
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CorpusLock;
  } catch {
    return undefined;
  }
}

export interface CorpusGateResult {
  ok: boolean;
  reason?: string;
  /** The current source-tree content hash (recorded into provenance regardless). */
  contentHash?: string;
  lock?: CorpusLock;
}

/**
 * Gate a corpus before an eval run: it must have a committed lockfile, that lock must
 * record a passing validation, and the live source tree must hash to the locked value.
 */
export function checkCorpusGate(corpusDir: string): CorpusGateResult {
  const lock = readCorpusLock(corpusDir);
  const contentHash = corpusContentHash(corpusDir);
  if (!lock) return { ok: false, reason: `no lockfile (${basename(corpusDir)}.lock.json) — run validate-corpus --write-lock`, contentHash };
  if (!lock.validated) return { ok: false, reason: `lockfile records a FAILED validation (${lock.summary?.quarantined ?? '?'} quarantined)`, contentHash, lock };
  if (contentHash !== lock.contentHash) {
    return { ok: false, reason: `corpus source drifted from lock — live ${contentHash} ≠ locked ${lock.contentHash}`, contentHash, lock };
  }
  return { ok: true, contentHash, lock };
}
