/**
 * HTTP transport with an AbortController timeout and bounded jittered-backoff
 * retry on transient failures (429, 5xx, network resets, timeouts). Small/local
 * model gateways are flaky and sometimes hang — this keeps the loop alive,
 * surfaces retries via `onRetry`, and reports a CLEAR timeout error (not the
 * raw "operation was aborted", which reads like a user interrupt).
 */

export interface FetchRetryOptions {
  timeoutMs: number;
  retries: number;
  signal?: AbortSignal;
  /** Called before each backoff so the UI can show "retrying…". */
  onRetry?: (info: { attempt: number; reason: string; nextInMs: number }) => void;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchRetryOptions,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, opts.timeoutMs);
    const onAbort = () => ac.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      if (RETRYABLE_STATUS.has(res.status) && attempt < opts.retries) {
        lastErr = new Error(`HTTP ${res.status}`);
        await backoff(attempt, `HTTP ${res.status}`, opts.onRetry);
        continue;
      }
      return res;
    } catch (err) {
      // Caller-initiated abort (e.g. user pressed ESC): propagate clearly, no retry.
      if (opts.signal?.aborted) throw new Error('interrupted');
      const reason = timedOut
        ? `timed out after ${opts.timeoutMs >= 1000 ? `${Math.round(opts.timeoutMs / 1000)}s` : `${opts.timeoutMs}ms`}`
        : 'network error';
      lastErr = new Error(`request ${reason}`);
      if (attempt < opts.retries) {
        await backoff(attempt, reason, opts.onRetry);
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr ?? new Error('fetchWithRetry: exhausted retries');
}

function backoff(
  attempt: number,
  reason: string,
  onRetry?: FetchRetryOptions['onRetry'],
): Promise<void> {
  const base = Math.min(1000 * 2 ** attempt, 8000);
  const jitter = base * 0.3 * Math.random();
  const delay = base + jitter;
  onRetry?.({ attempt: attempt + 1, reason, nextInMs: Math.round(delay) });
  return new Promise((resolve) => setTimeout(resolve, delay));
}
