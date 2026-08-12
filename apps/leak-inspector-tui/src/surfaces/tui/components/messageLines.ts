/**
 * Pure line-count / windowing helpers for the message viewport.
 *
 * MessageList renders into a fixed number of terminal rows, but messages are
 * not one line each — an expanded tool card or a long assistant reply spans
 * several lines. These helpers estimate each message's height (explicit
 * newlines + rough word-wrap) so the scroll window is computed in LINES, not
 * message counts. Kept free of React/Ink so both MessageList (rendering) and
 * App (scroll-offset math) use identical numbers.
 */
import type { UiMessage } from '../../../stores';

/** Cap on expanded tool output rendered in the viewport (see ToolCard). */
export const MAX_TOOL_OUTPUT_LINES = 24;

/** Effective text width used for wrap estimation (markers + margins). */
export function messageContentWidth(termCols: number): number {
  return Math.max(20, termCols - 12);
}

/** Rough wrapped-line count for a block of text at a given width. */
export function countLines(text: string, width: number): number {
  if (!text) return 1;
  let lines = 0;
  for (const seg of text.split('\n')) {
    lines += Math.max(1, Math.ceil((seg.length || 1) / Math.max(1, width)));
  }
  return Math.max(1, lines);
}

/** Estimated number of terminal lines one message occupies. */
export function messageHeight(m: UiMessage, termCols: number): number {
  const width = messageContentWidth(termCols);
  switch (m.kind) {
    case 'tool': {
      if (!m.tool) return 1;
      // Header line + (preview | line-capped expanded output) + clipped hint.
      const header = 1;
      if (m.collapsed !== false) {
        return header + (m.tool.preview ? 1 : 0);
      }
      const out = m.tool.output ?? '';
      const lines = countLines(out, width);
      const clipped = lines > MAX_TOOL_OUTPUT_LINES;
      return header + Math.min(lines, MAX_TOOL_OUTPUT_LINES) + (clipped ? 1 : 0);
    }
    case 'thinking': {
      if (m.collapsed !== false) return 1;
      const body = (m.text ?? '').trim();
      return body ? 1 + countLines(body, Math.max(20, width - 4)) : 1;
    }
    default:
      return countLines(m.text ?? '', width);
  }
}

export function totalMessageLines(messages: UiMessage[], termCols: number): number {
  let total = 0;
  for (const m of messages) total += messageHeight(m, termCols);
  return total;
}

export interface MessageWindow {
  visible: UiMessage[];
  /** Lines hidden above the window (scroll-up indicator). */
  above: number;
  /** Lines hidden below the window (scroll-down indicator). */
  below: number;
}

/**
 * Window `messages` so the visible slice spans `rows` terminal lines ending
 * `scrollOffset` lines above the live bottom (0 = pinned to the latest). A
 * message is included if ANY of its lines falls inside the window, so long
 * multi-line messages stay partially visible at the edges instead of being
 * clipped by a message-count slice.
 */
export function windowMessages(
  messages: UiMessage[],
  scrollOffset: number,
  rows: number,
  termCols: number,
): MessageWindow {
  const n = messages.length;
  if (n === 0) return { visible: [], above: 0, below: 0 };
  const heights = messages.map((m) => messageHeight(m, termCols));
  const total = heights.reduce((a, b) => a + b, 0);
  const scroll = Math.max(0, Math.min(total, scrollOffset));
  const targetEnd = total - scroll;
  const targetStart = Math.max(0, targetEnd - rows);

  // First message whose line-range contains targetStart.
  let acc = 0;
  let startIdx = 0;
  for (let i = 0; i < n; i++) {
    const hi = acc + heights[i];
    if (hi > targetStart) {
      startIdx = i;
      break;
    }
    acc = hi;
  }
  // First message whose line-range reaches/exceeds targetEnd.
  acc = 0;
  let endIdx = n - 1;
  for (let i = 0; i < n; i++) {
    const hi = acc + heights[i];
    if (hi >= targetEnd) {
      endIdx = i;
      break;
    }
    acc = hi;
  }

  return {
    visible: messages.slice(startIdx, endIdx + 1),
    above: targetStart,
    below: Math.max(0, total - targetEnd),
  };
}
