/**
 * Bounded-concurrency helpers shared across the loop's tool dispatch, discovery
 * scans, and the eval harness — one work-stealing pool instead of three copies.
 */

/**
 * Run `fn` over `items` with at most `limit` in flight at once. Work-stealing
 * (idle workers pick up the next index), so an uneven workload doesn't stall on
 * the slowest item. Preserves input order in the result array, so callers can
 * keep deterministic downstream processing regardless of completion order.
 */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker);
  await Promise.all(workers);
  return results;
}
