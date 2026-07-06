import { describe, expect, test } from 'bun:test';
import { mapWithLimit } from '../src/concurrency';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mapWithLimit', () => {
  test('preserves input order regardless of completion order', async () => {
    const items = [40, 10, 30, 0, 20];
    const out = await mapWithLimit(items, 3, async (n) => {
      await sleep(n); // later items may finish first
      return n * 2;
    });
    expect(out).toEqual([80, 20, 60, 0, 40]);
  });

  test('passes the index to fn', async () => {
    const out = await mapWithLimit(['a', 'b', 'c'], 2, async (item, i) => `${i}:${item}`);
    expect(out).toEqual(['0:a', '1:b', '2:c']);
  });

  test('never exceeds the concurrency limit in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually ran concurrently
  });

  test('empty input returns empty', async () => {
    expect(await mapWithLimit([], 4, async (x) => x)).toEqual([]);
  });
});
