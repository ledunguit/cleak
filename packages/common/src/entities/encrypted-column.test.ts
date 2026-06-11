import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { encryptedColumn } from './encrypted-column';

const KEY = 'TOKEN_ENC_KEY';
const orig = process.env[KEY];
afterEach(() => {
  if (orig === undefined) delete process.env[KEY];
  else process.env[KEY] = orig;
});

describe('encryptedColumn with a key set', () => {
  beforeEach(() => {
    process.env[KEY] = 'unit-test-secret';
  });

  test('round-trips a value through encrypt → decrypt', () => {
    const token = 'ghp_supersecrettoken1234567890';
    const stored = encryptedColumn.to(token) as string;
    expect(stored).toStartWith('enc:v1:');
    expect(stored).not.toContain(token); // ciphertext, not plaintext
    expect(encryptedColumn.from(stored)).toBe(token);
  });

  test('two encryptions of the same value differ (random IV)', () => {
    const a = encryptedColumn.to('same') as string;
    const b = encryptedColumn.to('same') as string;
    expect(a).not.toBe(b);
    expect(encryptedColumn.from(a)).toBe('same');
    expect(encryptedColumn.from(b)).toBe('same');
  });

  test('legacy plaintext rows (no prefix) pass through on read', () => {
    expect(encryptedColumn.from('legacy-plaintext-token')).toBe('legacy-plaintext-token');
  });

  test('null/undefined pass through unchanged', () => {
    expect(encryptedColumn.to(null)).toBeNull();
    expect(encryptedColumn.from(undefined)).toBeUndefined();
  });
});

describe('encryptedColumn without a key', () => {
  beforeEach(() => {
    delete process.env[KEY];
  });

  test('stores plaintext (back-compat) and reads it back', () => {
    const stored = encryptedColumn.to('plain') as string;
    expect(stored).toBe('plain'); // no key → no encryption
    expect(encryptedColumn.from('plain')).toBe('plain');
  });

  test('ciphertext written earlier is surfaced as-is when the key is gone', () => {
    process.env[KEY] = 'k';
    const stored = encryptedColumn.to('x') as string;
    delete process.env[KEY];
    // Can't decrypt without the key — returns the stored ciphertext rather than throwing.
    expect(encryptedColumn.from(stored)).toBe(stored);
  });
});
