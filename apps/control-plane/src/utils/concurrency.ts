/**
 * Bounded-concurrency map: run `fn` over `items` with at most `limit` in flight.
 * Used to parallelize independent gRPC/LLM calls (candidate scans, per-bundle
 * judging) that were previously awaited one-at-a-time — turning O(N) sequential
 * round-trips into O(N/limit) while protecting the analyzers / LLM gateway from
 * unbounded fan-out. Results preserve input order.
 */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results: R[] = new Array(n);
  const width = Math.max(1, Math.min(limit, n));
  let next = 0;
  const worker = async () => {
    while (next < n) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
