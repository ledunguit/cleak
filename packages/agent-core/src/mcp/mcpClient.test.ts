import { describe, expect, test } from 'bun:test';
import { isTransientError, retryTransient } from './mcpClient';

const noBackoff = () => 0;

describe('isTransientError', () => {
  test('matches socket-reset / closed-unexpectedly transport faults', () => {
    expect(isTransientError(new Error('read ECONNRESET'))).toBe(true);
    // The exact message the eval saw on the dropped case 32:
    expect(
      isTransientError(new Error('The socket connection was closed unexpectedly. For more information, pass `verbose: true`')),
    ).toBe(true);
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
    expect(isTransientError(new Error('write EPIPE'))).toBe(true);
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
    expect(isTransientError(new Error('connect ECONNREFUSED 127.0.0.1:50071'))).toBe(true);
    expect(isTransientError({ code: 'ECONNRESET' })).toBe(true);
    // undici/Bun wrap the socket fault in `cause`.
    expect(isTransientError({ message: 'boom', cause: { code: 'ECONNRESET' } })).toBe(true);
  });

  test('does NOT retry tool-level errors, aborts, or unknown faults', () => {
    expect(isTransientError(new Error('MCP tool memory.candidate_scan failed: bad args'))).toBe(false);
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isTransientError(abort)).toBe(false);
    expect(isTransientError(new Error('validation failed: missing field'))).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });
});

describe('retryTransient', () => {
  test('retries a transient failure, then succeeds', async () => {
    let calls = 0;
    const result = await retryTransient(
      async () => {
        calls++;
        if (calls < 2) throw new Error('read ECONNRESET');
        return 'ok';
      },
      { maxRetries: 3, backoffMs: noBackoff },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  test('runs beforeRetry (the reconnect hook) once per retry', async () => {
    let calls = 0;
    let reconnects = 0;
    await retryTransient(
      async () => {
        calls++;
        if (calls < 3) throw new Error('socket hang up');
        return 1;
      },
      { maxRetries: 3, backoffMs: noBackoff, beforeRetry: () => { reconnects++; } },
    );
    expect(calls).toBe(3);
    expect(reconnects).toBe(2);
  });

  test('does NOT retry a non-transient (tool-level) error', async () => {
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls++;
          throw new Error('MCP tool x failed: nope');
        },
        { maxRetries: 3, backoffMs: noBackoff },
      ),
    ).rejects.toThrow('MCP tool x failed');
    expect(calls).toBe(1);
  });

  test('throws the last error after exhausting the retry budget', async () => {
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls++;
          throw new Error('read ECONNRESET');
        },
        { maxRetries: 2, backoffMs: noBackoff },
      ),
    ).rejects.toThrow('ECONNRESET');
    expect(calls).toBe(3); // initial attempt + 2 retries
  });

  test('does NOT retry once the abort signal is set', async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls++;
          throw new Error('read ECONNRESET');
        },
        { maxRetries: 3, backoffMs: noBackoff, signal: ac.signal },
      ),
    ).rejects.toThrow('ECONNRESET');
    expect(calls).toBe(1);
  });
});
