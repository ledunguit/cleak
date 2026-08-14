/**
 * Corpus catalog for the standalone eval CLI: merges the three KNOWN datasets
 * (documented in docs/DATASETS.md + scripts/memhint/ingest.ts) — which may not be
 * ingested yet — with whatever `discoverCorpora()` finds already materialized
 * (known or ad hoc). This is the piece that doesn't exist anywhere else: neither
 * the TUI's `/eval` wizard nor `discoverCorpora()` itself lists a corpus that has
 * no `corpus_manifest.json` yet — they just silently omit it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkCorpusGate, type CorpusGateResult } from '../apps/leak-inspector-tui/src/domain/corpusLock';
import { discoverCorpora } from '../apps/leak-inspector-tui/src/domain/corpusDiscovery';

export type IngestKind = 'juliet' | 'lamed' | 'memhint';

export interface KnownCorpus {
  key: IngestKind;
  label: string;
  /** Relative to repo root — resolved to absolute when building the catalog. */
  outDir: string;
}

export const KNOWN_CORPORA: KnownCorpus[] = [
  { key: 'juliet', label: 'Juliet CWE-401 (NIST synthetic)', outDir: 'demo/juliet_cwe401' },
  { key: 'lamed', label: 'LAMeD (EASE 2025, real-project, positive-only)', outDir: 'demo/lamed' },
  { key: 'memhint', label: 'MemHint-derived (real-project, positive-only)', outDir: 'demo/memhint' },
];

export type CatalogStatus = 'validated' | 'unvalidated-has-manifest' | 'not-ingested';

export interface CatalogEntry {
  key: string;
  label: string;
  /** Absolute path. */
  outDir: string;
  status: CatalogStatus;
  gate?: CorpusGateResult;
  caseCount?: number;
  /** Undefined for ad hoc corpora discoverCorpora() found that aren't one of the
   * three known ones — there's no ingest script to offer for those. */
  ingestKind?: IngestKind;
}

function caseCountOf(dir: string): number | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'corpus_manifest.json'), 'utf-8'));
    return Array.isArray(manifest.cases) ? manifest.cases.length : undefined;
  } catch {
    return undefined;
  }
}

/** Build the full catalog: known datasets (ingested or not) + anything else
 * `discoverCorpora()` finds under `demo/`, deduped by resolved absolute dir. */
export function buildCatalog(cwd: string = process.cwd()): CatalogEntry[] {
  const byDir = new Map<string, CatalogEntry>();

  for (const known of KNOWN_CORPORA) {
    const abs = resolve(cwd, known.outDir);
    const hasManifest = existsSync(join(abs, 'corpus_manifest.json'));
    const gate = hasManifest ? checkCorpusGate(abs) : undefined;
    byDir.set(abs, {
      key: known.key,
      label: known.label,
      outDir: abs,
      status: !hasManifest ? 'not-ingested' : gate!.ok ? 'validated' : 'unvalidated-has-manifest',
      gate,
      caseCount: hasManifest ? caseCountOf(abs) : undefined,
      ingestKind: known.key,
    });
  }

  // Anything discoverCorpora() finds (has a manifest) that isn't already one of
  // the three known dirs above — e.g. a corpus dropped ad hoc under demo/.
  for (const info of discoverCorpora(undefined, cwd)) {
    if (byDir.has(info.dir)) continue;
    byDir.set(info.dir, {
      key: info.name,
      label: info.name,
      outDir: info.dir,
      status: info.gate.ok ? 'validated' : 'unvalidated-has-manifest',
      gate: info.gate,
      caseCount: info.caseCount,
    });
  }

  return [...byDir.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** One-line label for a picker row. */
export function statusLabel(entry: CatalogEntry): string {
  const count = entry.caseCount != null ? `${entry.caseCount} cases` : '—';
  if (entry.status === 'validated') return `${entry.label} (${count}) — ✓ validated`;
  if (entry.status === 'unvalidated-has-manifest') return `${entry.label} (${count}) — ✗ ${entry.gate?.reason ?? 'not validated'}`;
  return `${entry.label} — not ingested yet`;
}
