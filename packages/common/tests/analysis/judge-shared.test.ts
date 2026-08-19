import { describe, expect, test } from 'vitest';
import { isQuotaExhaustedError, QuotaExhaustedError } from '../../src/analysis/judge-shared';

describe('isQuotaExhaustedError', () => {
  test('status 429 → true, regardless of message text', () => {
    const err = Object.assign(new Error('LLM error 429: boom'), { status: 429 });
    expect(isQuotaExhaustedError(err)).toBe(true);
  });

  test.each([
    'quota exceeded',
    'Quota Exceeded',
    'rate limit exceeded',
    'rate-limit exceeded',
    'too many requests',
    'usage limit reached',
    'insufficient quota',
    'insufficient credit',
    'insufficient balance',
  ])('message text %j → true (no status attached)', (text) => {
    expect(isQuotaExhaustedError(new Error(text))).toBe(true);
  });

  test.each(['request network error', 'request timed out after 30s', 'request timed out after 1500ms', 'LLM stream had no response body', 'fetchWithRetry: exhausted retries'])(
    'transport.ts post-retry-exhaustion message %j → true (a transient version never reaches here)',
    (text) => {
      expect(isQuotaExhaustedError(new Error(text))).toBe(true);
    },
  );

  test("'interrupted' (deliberate cancellation) → false, even though it's an Error", () => {
    expect(isQuotaExhaustedError(new Error('interrupted'))).toBe(false);
  });

  test('a non-429 status with a generic message → true (any structured status = a real response was received after retries)', () => {
    const err = Object.assign(new Error('LLM error 500: internal error'), { status: 500 });
    expect(isQuotaExhaustedError(err)).toBe(true);
  });

  test('an unrelated error with no status and no known transport-exhaustion shape → false (stays precise, not "catch everything")', () => {
    expect(isQuotaExhaustedError(new Error('unexpected token in JSON'))).toBe(false);
  });

  test('non-Error values → false', () => {
    expect(isQuotaExhaustedError('quota exceeded')).toBe(false);
    expect(isQuotaExhaustedError(undefined)).toBe(false);
    expect(isQuotaExhaustedError(null)).toBe(false);
  });
});

describe('QuotaExhaustedError', () => {
  test('carries the original cause and message', () => {
    const cause = new Error('rate limit exceeded');
    const err = new QuotaExhaustedError(cause);
    expect(err.name).toBe('QuotaExhaustedError');
    expect(err.cause).toBe(cause);
    expect(err.message).toBe('rate limit exceeded');
  });

  test('stringifies a non-Error cause', () => {
    const err = new QuotaExhaustedError('plain string cause');
    expect(err.message).toBe('plain string cause');
  });
});
