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

function secs(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

export interface StreamOptions {
  /** Time-to-first-byte budget (waiting for response headers). */
  connectTimeoutMs: number;
  /** Max silence between streamed chunks before the request is treated as hung. */
  idleTimeoutMs: number;
  retries: number;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; reason: string; nextInMs: number }) => void;
  /** Reset the per-attempt accumulator before (re)reading the stream. */
  onAttemptStart?: () => void;
  /** Fired once, when the first `data:` payload of the (final) attempt is delivered. */
  onFirstChunk?: () => void;
  /** Handle one SSE `data:` payload (already stripped of the `data:` prefix). */
  onData: (payload: string) => void;
  /** Gateway ignored `stream:true` and returned a single JSON body instead. */
  onJsonFallback: (raw: string) => void;
}

/**
 * Streaming counterpart to {@link fetchWithRetry}. The key difference: instead of
 * a single total-deadline timeout over the whole request (which kills healthy but
 * slow generations), the abort timer is an *idle* timer re-armed on every chunk —
 * only `idleTimeoutMs` of true silence aborts. A short `connectTimeoutMs` guards
 * time-to-first-byte. Retries fire only for failures *before any data was
 * delivered* (connect timeout, retryable status, pre-stream network error); once
 * tokens start flowing an idle timeout bubbles up so the caller can pause/resume
 * rather than wastefully re-POSTing a huge request.
 */
export async function streamWithRetry(url: string, init: RequestInit, opts: StreamOptions): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    const ac = new AbortController();
    let phase: 'connecting' | 'streaming' = 'connecting';
    let delivered = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, ms);
    };
    const onAbort = () => ac.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    opts.onAttemptStart?.();
    arm(opts.connectTimeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      if (RETRYABLE_STATUS.has(res.status) && attempt < opts.retries) {
        lastErr = new Error(`HTTP ${res.status}`);
        await backoff(attempt, `HTTP ${res.status}`, opts.onRetry);
        continue;
      }
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        throw new Error(`LLM error ${res.status}: ${err.slice(0, 300)}`);
      }

      const ctype = res.headers.get('content-type') ?? '';
      // Gateway ignored stream:true and returned a normal JSON body.
      if (!ctype.includes('text/event-stream')) {
        const raw = await res.text();
        if (/^\s*data:/.test(raw)) {
          // Mislabeled SSE — drain it through the same line parser.
          drainSse(raw, opts.onData, () => {
            if (!delivered) opts.onFirstChunk?.();
            delivered = true;
          });
        } else {
          opts.onJsonFallback(raw);
        }
        return;
      }

      // True streaming: re-arm the idle timer on every chunk.
      phase = 'streaming';
      arm(opts.idleTimeoutMs);
      const body = res.body;
      if (!body) throw new Error('LLM stream had no response body');
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        arm(opts.idleTimeoutMs);
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '').trim();
          buf = buf.slice(nl + 1);
          if (!line || line.startsWith(':')) continue; // blank line / SSE comment (heartbeat)
          if (!line.startsWith('data:')) continue; // ignore `event:` etc — type lives in the JSON
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          if (!delivered) opts.onFirstChunk?.();
          delivered = true;
          opts.onData(payload);
        }
      }
      return;
    } catch (err: unknown) {
      if (opts.signal?.aborted) throw new Error('interrupted');
      const reason = timedOut
        ? phase === 'connecting'
          ? `connect timed out after ${secs(opts.connectTimeoutMs)}`
          : `stalled (no data for ${secs(opts.idleTimeoutMs)})`
        : 'network error';
      lastErr = new Error(`request ${reason}`);
      // Retry only pre-stream failures; never re-POST a request that already streamed.
      if (!delivered && attempt < opts.retries) {
        await backoff(attempt, reason, opts.onRetry);
        continue;
      }
      throw lastErr;
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr ?? new Error('streamWithRetry: exhausted retries');
}

/** Feed every `data:` line of a buffered SSE text through `onData`. */
function drainSse(text: string, onData: (p: string) => void, mark: () => void): void {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    mark();
    onData(payload);
  }
}
