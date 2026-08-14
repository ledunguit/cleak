import { describe, it, expect } from 'vitest';
import { runWithContext, getContext, withMergedContext, type RequestContext } from '../src/mcp/request-context.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('request-context', () => {
  it('returns undefined outside any runWithContext call', () => {
    expect(getContext()).toBeUndefined();
  });

  it('exposes the active context inside runWithContext', async () => {
    await runWithContext({ requestId: 'r1', label: 'static-analyzer' }, async () => {
      expect(getContext()?.requestId).toBe('r1');
    });
  });

  it('withMergedContext adds fields without dropping existing ones', async () => {
    await runWithContext({ requestId: 'r1', correlationId: 'scan-1', label: 'static-analyzer' }, async () => {
      await withMergedContext({ tool: 'candidateScan' }, async () => {
        const ctx = getContext();
        expect(ctx?.requestId).toBe('r1');
        expect(ctx?.correlationId).toBe('scan-1');
        expect(ctx?.tool).toBe('candidateScan');
      });
    });
  });

  it('never cross-contaminates across concurrent requests', async () => {
    const n = 20;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        runWithContext({ requestId: `r${i}`, label: 'dynamic-analyzer' } satisfies RequestContext, async () => {
          await sleep(Math.random() * 20);
          return getContext()?.requestId;
        }),
      ),
    );
    results.forEach((r, i) => expect(r).toBe(`r${i}`));
  });
});
