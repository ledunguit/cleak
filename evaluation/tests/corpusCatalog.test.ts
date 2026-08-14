import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildCatalog, statusLabel, KNOWN_CORPORA } from '../corpusCatalog';

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'cleak-catalog-'));
}

describe('buildCatalog', () => {
  test('an empty checkout lists all known corpora as not-ingested', () => {
    const cwd = scratchDir();
    const catalog = buildCatalog(cwd);
    expect(catalog).toHaveLength(KNOWN_CORPORA.length);
    for (const entry of catalog) {
      expect(entry.status).toBe('not-ingested');
      expect(entry.gate).toBeUndefined();
      expect(entry.caseCount).toBeUndefined();
    }
  });

  test('a manifest with no lockfile is unvalidated-has-manifest, not validated', () => {
    const cwd = scratchDir();
    const julietDir = join(cwd, 'demo/juliet_cwe401');
    mkdirSync(julietDir, { recursive: true });
    writeFileSync(
      join(julietDir, 'corpus_manifest.json'),
      JSON.stringify({ cases: [{ id: 'a', repo_path: 'a' }, { id: 'b', repo_path: 'b' }] }),
    );

    const catalog = buildCatalog(cwd);
    const entry = catalog.find((c) => c.key === 'juliet')!;
    expect(entry.status).toBe('unvalidated-has-manifest');
    expect(entry.caseCount).toBe(2);
    expect(entry.gate?.ok).toBe(false);
  });

  test('an ad hoc corpus dropped under demo/ is discovered with no ingestKind', () => {
    const cwd = scratchDir();
    const adhocDir = join(cwd, 'demo/my-custom-corpus');
    mkdirSync(adhocDir, { recursive: true });
    writeFileSync(join(adhocDir, 'corpus_manifest.json'), JSON.stringify({ cases: [] }));

    const catalog = buildCatalog(cwd);
    const entry = catalog.find((c) => c.outDir === adhocDir);
    expect(entry).toBeDefined();
    expect(entry!.ingestKind).toBeUndefined();
    expect(entry!.status).toBe('unvalidated-has-manifest');
  });

  test('known corpora are never duplicated by the ad hoc sibling-scan', () => {
    const cwd = scratchDir();
    const julietDir = join(cwd, 'demo/juliet_cwe401');
    mkdirSync(julietDir, { recursive: true });
    writeFileSync(join(julietDir, 'corpus_manifest.json'), JSON.stringify({ cases: [] }));

    const catalog = buildCatalog(cwd);
    const matches = catalog.filter((c) => c.outDir === julietDir);
    expect(matches).toHaveLength(1);
    expect(matches[0].ingestKind).toBe('juliet');
  });
});

describe('statusLabel', () => {
  test('not-ingested', () => {
    expect(statusLabel({ key: 'juliet', label: 'Juliet', outDir: '/x', status: 'not-ingested' })).toBe('Juliet — not ingested yet');
  });

  test('unvalidated-has-manifest shows the gate reason', () => {
    expect(
      statusLabel({
        key: 'juliet',
        label: 'Juliet',
        outDir: '/x',
        status: 'unvalidated-has-manifest',
        caseCount: 5,
        gate: { ok: false, reason: 'no lockfile' },
      }),
    ).toBe('Juliet (5 cases) — ✗ no lockfile');
  });

  test('validated', () => {
    expect(
      statusLabel({ key: 'juliet', label: 'Juliet', outDir: '/x', status: 'validated', caseCount: 1658 }),
    ).toBe('Juliet (1658 cases) — ✓ validated');
  });
});
