/**
 * Context compaction. The agent loop appends every tool result to the message
 * history and re-sends the whole transcript each turn, so a long investigation
 * grows unbounded — eventually overflowing the model's context window and making
 * each generation slower (which, with a streamed idle timeout, still wastes wall
 * clock). The bulk of that growth is large tool-result payloads (function
 * summaries, path constraints, file reads). Pruning the *stale* ones — outside a
 * sliding window of recent turns — keeps requests small without an extra LLM
 * call, deterministically, and without breaking tool_use↔tool_result pairing
 * (we shrink the result content in place, never drop the block).
 */

import type { Message, ContentBlock } from './types';

/** Result-content shorter than this is left alone (errors, tiny payloads). */
const MIN_PRUNABLE_CHARS = 200;
const PLACEHOLDER_PREFIX = '[elided:';

function isPlaceholder(content: string): boolean {
  return content.startsWith(PLACEHOLDER_PREFIX);
}

/** Cheap token estimate (~4 chars/token) for when the gateway reports no usage. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'text') chars += b.text.length;
      else if (b.type === 'tool_use') chars += b.name.length + JSON.stringify(b.input ?? {}).length;
      else if (b.type === 'tool_result') chars += b.content.length;
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Replace tool-result payloads from older turns with a short placeholder,
 * keeping the most recent `keepRecentTurns` tool-result messages intact. Mutates
 * `messages` in place; returns the number of characters reclaimed. The system
 * prompt, the initial user message, assistant text, and recorded verdicts are
 * never touched — only `tool_result` block content outside the window.
 */
export function pruneStaleToolResults(messages: Message[], keepRecentTurns: number): number {
  // Indices of user messages that carry tool results (one per agent turn).
  const carrierIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')) {
      carrierIdx.push(i);
    }
  }
  const cutoff = carrierIdx.length - Math.max(0, keepRecentTurns);
  if (cutoff <= 0) return 0;

  let saved = 0;
  for (let k = 0; k < cutoff; k++) {
    const content = messages[carrierIdx[k]].content as ContentBlock[];
    for (const b of content) {
      if (b.type !== 'tool_result' || isPlaceholder(b.content) || b.content.length < MIN_PRUNABLE_CHARS) continue;
      const n = b.content.length;
      saved += n;
      b.content = `${PLACEHOLDER_PREFIX} ${n} chars of stale tool output pruned to save context]`;
    }
  }
  return saved;
}
