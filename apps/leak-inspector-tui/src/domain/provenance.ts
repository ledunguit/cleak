/**
 * Reproducibility provenance for an eval run: the exact model/temperature, the
 * versions of the external tools that produced dynamic evidence (valgrind/clang),
 * the git commit of the analyzer code, and a hash of the corpus manifest. These
 * are recorded alongside the metrics so a reported Precision/Recall/F1 can be
 * traced to — and re-run against — the precise configuration that produced it.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface EvalProvenance {
  /** ISO timestamp set by the caller (kept out of here so the harness stays pure). */
  provider?: string;
  model?: string;
  temperature?: number;
  /** Independent runs aggregated into this result (1 unless multi-run variance). */
  runs?: number;
  gitCommit?: string;
  toolVersions: Record<string, string>;
  /** Content hash over ALL corpus SOURCE files (not just the manifest), so source
   * drift/corruption is detectable — see corpusLock.ts. */
  corpusHash?: string;
  /** Whether the corpus passed the integrity gate (lockfile present, validated, no
   * drift). False ⇒ this number was measured on UNVERIFIED data (--allow-unvalidated). */
  corpusValidated?: boolean;
  /** Consensus-judge configuration for this run (records the ablation condition). */
  consensus?: { n: number; rule: string };
}

/** Run a version command without a shell; never throws (returns undefined). */
function probe(bin: string, args: string[]): string | undefined {
  try {
    const out = execFileSync(bin, args, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n')[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

let cachedGit: string | null | undefined;
let cachedTools: Record<string, string> | undefined;

function gitCommit(): string | undefined {
  if (cachedGit === undefined) {
    cachedGit = probe('git', ['rev-parse', 'HEAD']) ?? null;
  }
  return cachedGit ?? undefined;
}

/** Captured once per process — these don't change between cases in a run. */
function toolVersions(dynamicEnabled: boolean): Record<string, string> {
  if (!cachedTools) {
    cachedTools = {};
    const clang = probe('clang', ['--version']);
    if (clang) cachedTools.clang = clang;
    if (dynamicEnabled) {
      const valgrind = probe('valgrind', ['--version']);
      if (valgrind) cachedTools.valgrind = valgrind;
    }
  }
  return cachedTools;
}

function corpusHash(manifestPath: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(manifestPath)).digest('hex').slice(0, 16);
  } catch {
    return undefined;
  }
}

export function captureProvenance(opts: {
  provider?: string;
  model?: string;
  temperature?: number;
  dynamicEnabled: boolean;
  /** Content hash over corpus source files (from corpusLock.checkCorpusGate). Falls
   * back to a manifest-only hash if not supplied (legacy callers). */
  corpusHash?: string;
  corpusValidated?: boolean;
  manifestPath?: string;
  runs?: number;
  consensus?: { n: number; rule: string };
}): EvalProvenance {
  const hash = opts.corpusHash ?? (opts.manifestPath ? corpusHash(opts.manifestPath) : undefined);
  return {
    provider: opts.provider,
    model: opts.model,
    temperature: opts.temperature,
    runs: opts.runs,
    gitCommit: gitCommit(),
    toolVersions: toolVersions(opts.dynamicEnabled),
    ...(hash ? { corpusHash: hash } : {}),
    ...(opts.corpusValidated !== undefined ? { corpusValidated: opts.corpusValidated } : {}),
    ...(opts.consensus ? { consensus: opts.consensus } : {}),
  };
}

/** Mean / sample-stddev / range of a numeric series — for multi-run variance. */
export interface Stat {
  mean: number;
  std: number;
  min: number;
  max: number;
  n: number;
}

export function summarizeStat(values: number[]): Stat {
  const n = values.length;
  if (n === 0) return { mean: 0, std: 0, min: 0, max: 0, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  // Sample standard deviation (n-1); 0 for a single run.
  const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, std: Math.sqrt(variance), min: Math.min(...values), max: Math.max(...values), n };
}
