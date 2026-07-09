#!/usr/bin/env bun
/** Verifies fetchWithRetry: clear timeout message, onRetry fires, caller-abort → 'interrupted'. */

import { fetchWithRetry } from '@cleak/agent-core';

const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
const url = `http://localhost:${hang.port}/`;

// ── timeout + retry ──
const notices: string[] = [];
try {
  await fetchWithRetry(
    url,
    { method: 'GET' },
    { timeoutMs: 400, retries: 1, onRetry: (i) => notices.push(`${i.reason}#${i.attempt}`) },
  );
  console.error('✗ expected a timeout');
  process.exit(1);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/timed out/.test(msg)) {
    console.error(`✗ unclear timeout message: ${msg}`);
    process.exit(1);
  }
  if (notices.length !== 1) {
    console.error(`✗ onRetry should fire once, got ${notices.length}`);
    process.exit(1);
  }
  console.log(`✓ timeout: "${msg}" · retry notice: ${notices[0]}`);
}

// ── caller abort ──
const ac = new AbortController();
setTimeout(() => ac.abort(), 150);
try {
  await fetchWithRetry(url, { method: 'GET' }, { timeoutMs: 5000, retries: 2, signal: ac.signal });
  console.error('✗ expected abort');
  process.exit(1);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg !== 'interrupted') {
    console.error(`✗ caller abort should say 'interrupted', got '${msg}'`);
    process.exit(1);
  }
  console.log(`✓ caller abort → "interrupted" (not retried)`);
}

hang.stop();
console.log('✓ transport resilience verified');
process.exit(0);
