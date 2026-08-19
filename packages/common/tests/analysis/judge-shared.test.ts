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

  test.each(['request network error', 'timed out after 30s', 'malformed JSON in response', 'HTTP 500'])(
    'generic error message %j → false',
    (text) => {
      expect(isQuotaExhaustedError(new Error(text))).toBe(false);
    },
  );

  test('non-Error values → false', () => {
    expect(isQuotaExhaustedError('quota exceeded')).toBe(false);
    expect(isQuotaExhaustedError(undefined)).toBe(false);
    expect(isQuotaExhaustedError(null)).toBe(false);
  });

  test('a non-429 status with a generic message → false', () => {
    const err = Object.assign(new Error('LLM error 500: internal error'), { status: 500 });
    expect(isQuotaExhaustedError(err)).toBe(false);
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
