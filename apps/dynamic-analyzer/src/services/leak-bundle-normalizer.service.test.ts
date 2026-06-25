import { describe, expect, test } from 'bun:test';
import { LeakBundleNormalizerService } from './leak-bundle-normalizer.service';

const svc = new LeakBundleNormalizerService();
const frame = (function_: string | null, file: string | null = null, line: number | null = null) => ({
  function: function_,
  file,
  line,
});
const finding = (kind: string, message: string, stack = [frame('malloc'), frame('make_buffer', 'main.c', 10)], aux = {}) => ({
  kind,
  message,
  stack,
  originStack: [],
  aux,
});

describe('normalizeMemcheck', () => {
  test('a definitely-lost leak → medium severity, location from the top user-ish frame', () => {
    const r = svc.normalizeMemcheck('run1', [finding('Leak_DefinitelyLost', 'definitely lost', undefined, { leak: { bytes: 100 } })]);
    expect(r.tool).toBe('memcheck');
    expect(r.findings.length).toBe(1);
    const f = r.findings[0];
    expect(f.severity).toBe('medium');
    expect(f.kind).toBe('Leak_DefinitelyLost');
    expect(f.location).toEqual({ file: null, line: null, function: 'malloc' }); // top frame
    expect(f.aux).toEqual({ leak: { bytes: 100 } });
    expect(f.findingId).toBe('mc-0001');
  });

  test('an invalid read → high severity (UAF/overflow class)', () => {
    const r = svc.normalizeMemcheck('r', [finding('InvalidRead', 'Invalid read of size 4')]);
    expect(r.findings[0].severity).toBe('high');
    expect(r.stats).toMatchObject({ findingCount: 1, high: 1, medium: 0, low: 0 });
  });

  test('possibly-lost → low severity; stats aggregate by bucket', () => {
    const r = svc.normalizeMemcheck('r', [
      finding('Leak_DefinitelyLost', 'definitely lost'),
      finding('Leak_PossiblyLost', 'possibly lost'),
      finding('InvalidWrite', 'Invalid write of size 8'),
    ]);
    expect(r.stats).toEqual({ findingCount: 3, high: 1, medium: 1, low: 1 });
  });

  test('empty input → empty report with zeroed stats', () => {
    const r = svc.normalizeMemcheck('r', []);
    expect(r.findings).toEqual([]);
    expect(r.stats).toEqual({ findingCount: 0, high: 0, medium: 0, low: 0 });
  });
});

describe('normalizeAsan', () => {
  test('a leak kind → medium; a use-after-free → high', () => {
    const leak = svc.normalizeAsan('r', [finding('detected memory leaks', 'LeakSanitizer')]);
    expect(leak.findings[0].severity).toBe('medium');
    expect(leak.findings[0].tool).toBe('asan');
    const uaf = svc.normalizeAsan('r', [finding('heap-use-after-free on address 0x1', 'x')]);
    expect(uaf.findings[0].severity).toBe('high');
    expect(uaf.findings[0].findingId).toBe('asan-0001');
  });
});

describe('computeSignature (via output)', () => {
  test('is stable for identical findings and differs when the site differs', () => {
    const a1 = svc.normalizeMemcheck('r', [finding('Leak_DefinitelyLost', 'lost', [frame('f', 'a.c', 1)])]).findings[0].signature;
    const a2 = svc.normalizeMemcheck('OTHER_RUN', [finding('Leak_DefinitelyLost', 'lost', [frame('f', 'a.c', 1)])]).findings[0].signature;
    const b = svc.normalizeMemcheck('r', [finding('Leak_DefinitelyLost', 'lost', [frame('f', 'a.c', 2)])]).findings[0].signature;
    expect(a1).toBe(a2); // signature ignores runId — same leak, same signature
    expect(a1).not.toBe(b); // different line → different signature
    expect(a1).toMatch(/^[0-9a-f]{40}$/); // sha1 hex
  });
});
