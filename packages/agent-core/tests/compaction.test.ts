import { describe, expect, test } from 'bun:test';
import { estimateTokens, pruneStaleToolResults } from '../src/compaction';
import type { Message } from '../src/types';

const big = (s: string, n = 400) => s.repeat(Math.ceil(n / s.length)).slice(0, n);

/** A transcript: system-ish initial user msg, then `turns` (assistant tool_use + user tool_result) pairs. */
function transcript(turns: number): Message[] {
  const msgs: Message[] = [{ role: 'user', content: 'Investigate these candidates: c1, c2.' }];
  for (let t = 0; t < turns; t++) {
    msgs.push({
      role: 'assistant',
      content: [
        { type: 'text', text: `Turn ${t} reasoning` },
        { type: 'tool_use', id: `tu${t}`, name: 'functionSummary', input: { fn: `f${t}` } },
      ],
    });
    msgs.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `tu${t}`, content: big(`RESULT-${t}-`) }],
    });
  }
  return msgs;
}

describe('pruneStaleToolResults', () => {
  test('elides tool results outside the recent window, keeps pairing', () => {
    const msgs = transcript(6);
    const saved = pruneStaleToolResults(msgs, 2);
    expect(saved).toBeGreaterThan(0);

    const carriers = msgs.filter(
      (m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
    );
    // 6 carriers; keep last 2 → first 4 elided.
    const elided = carriers.filter((m) =>
      (m.content as any[]).every((b) => b.type !== 'tool_result' || b.content.startsWith('[elided:')),
    );
    expect(elided.length).toBe(4);

    // Every tool_result still has its tool_use_id (pairing intact).
    for (const m of carriers) {
      for (const b of m.content as any[]) {
        if (b.type === 'tool_result') expect(typeof b.tool_use_id).toBe('string');
      }
    }
    // Most recent 2 untouched.
    const recent = carriers.slice(-2);
    for (const m of recent) {
      for (const b of m.content as any[]) {
        if (b.type === 'tool_result') expect(b.content.startsWith('[elided:')).toBe(false);
      }
    }
  });

  test('never touches the initial user message or assistant text', () => {
    const msgs = transcript(5);
    pruneStaleToolResults(msgs, 1);
    expect(msgs[0].content).toBe('Investigate these candidates: c1, c2.');
    const firstAssistant = msgs[1].content as any[];
    expect(firstAssistant.find((b) => b.type === 'text').text).toBe('Turn 0 reasoning');
  });

  test('idempotent — second pass reclaims nothing', () => {
    const msgs = transcript(5);
    const first = pruneStaleToolResults(msgs, 2);
    const second = pruneStaleToolResults(msgs, 2);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });

  test('no-op when fewer carriers than the window', () => {
    const msgs = transcript(2);
    expect(pruneStaleToolResults(msgs, 3)).toBe(0);
  });

  test('leaves small results (errors) alone', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Permission denied.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'y', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'ok' }] },
    ];
    expect(pruneStaleToolResults(msgs, 1)).toBe(0);
  });
});

describe('estimateTokens', () => {
  test('grows with content and is non-zero', () => {
    const small = estimateTokens(transcript(1));
    const large = estimateTokens(transcript(10));
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
  });
});
