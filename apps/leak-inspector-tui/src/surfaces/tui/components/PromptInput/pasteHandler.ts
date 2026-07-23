/**
 * Pure data transformation for multi-line paste insertion.
 *
 * Takes raw pasted text, normalises line endings (CRLF → LF) and trims trailing
 * whitespace per line, then inserts the result at the given cursor position.
 * Returns the new buffer value and the updated cursor offset — no React / Ink
 * dependency, no side effects, easily unit-testable.
 *
 * Edge cases handled:
 *   - paste at start  (cursor = 0)
 *   - paste at end    (cursor = value.length)
 *   - paste into empty buffer (value = '')
 *   - single-line paste (no line-splitting changes the text)
 *   - mixed CRLF / LF line endings
 */

export interface PasteResult {
  value: string;
  cursor: number;
}

/**
 * Insert `text` at `cursor` inside `value`, normalising multi-line input.
 *
 * @param text   — the raw pasted text (may contain newlines)
 * @param value  — the current buffer content
 * @param cursor — the current cursor offset (0 … value.length)
 */
export function handlePaste(text: string, value: string, cursor: number): PasteResult {
  // Normalise CRLF → LF, split on newlines, strip trailing whitespace per line
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const normalized = lines.map((l) => l.trimEnd()).join('\n');

  // Clamp cursor (defensive — should never be out of range in practice)
  const clamped = Math.max(0, Math.min(cursor, value.length));

  const newValue = value.slice(0, clamped) + normalized + value.slice(clamped);
  const newCursor = clamped + normalized.length;

  return { value: newValue, cursor: newCursor };
}
