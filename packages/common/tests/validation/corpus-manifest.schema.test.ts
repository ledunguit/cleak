import { describe, expect, test } from 'bun:test';
import { safeParseManifest, parseManifest } from '../../src/validation/corpus-manifest.schema';

const validCase = { id: 'c1', repo_path: 'cases/c1', flaws: [{ function: 'bad', cwe: 'CWE-401' }], clean: [{ function: 'goodB2G' }] };

describe('corpus-manifest zod schema', () => {
  test('accepts a well-formed v2 manifest', () => {
    const m = { schema_version: 'memory-leak-corpus/v2', name: 'x', cases: [validCase] };
    expect(safeParseManifest(m).success).toBe(true);
  });

  test('tolerates provenance extras (passthrough)', () => {
    const m = { schema_version: 'v2', cases: [{ ...validCase, _lamed: { bugRef: 'x' }, source_origin: '/nist/…' }] };
    expect(safeParseManifest(m).success).toBe(true);
  });

  test('rejects a missing schema_version', () => {
    const r = safeParseManifest({ cases: [validCase] });
    expect(r.success).toBe(false);
  });

  test('rejects an empty cases array', () => {
    expect(safeParseManifest({ schema_version: 'v2', cases: [] }).success).toBe(false);
  });

  test('rejects a case with no flaws and no expected_leak_count (unscoreable)', () => {
    const r = safeParseManifest({ schema_version: 'v2', cases: [{ id: 'c', repo_path: 'cases/c' }] });
    expect(r.success).toBe(false);
  });

  test('accepts a v1 expected_leak_count case (back-compat)', () => {
    const m = { schema_version: 'v1', cases: [{ id: 'c', repo_path: 'cases/c', expected_leak_count: 1 }] };
    expect(safeParseManifest(m).success).toBe(true);
  });

  test('parseManifest throws on a malformed manifest', () => {
    expect(() => parseManifest({ schema_version: 'v2' })).toThrow();
  });
});
