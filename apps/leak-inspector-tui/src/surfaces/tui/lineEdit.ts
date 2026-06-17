/**
 * Pure, framework-free line-editing core for the prompt. The TUI's input is a
 * controlled value + a cursor offset; every keystroke maps to an `EditIntent`
 * (`keyToIntent`) which `reduce` applies to `{ value, cursor }`. Keeping this
 * independent of Ink/React makes the readline keybindings unit-testable without
 * a terminal — the component (`PromptInput.tsx`) is a thin shell over it.
 *
 * Word boundaries are whitespace-delimited (predictable for both word-motion and
 * word-delete). Cursor is a UTF-16 offset clamped to `[0, value.length]`.
 */

export interface EditState {
  value: string;
  cursor: number;
}

export type EditIntent =
  | { type: 'insert'; text: string }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'wordLeft' }
  | { type: 'wordRight' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'deleteBack' }
  | { type: 'deleteWordBack' }
  | { type: 'killToStart' }
  | { type: 'killToEnd' };

/** The Ink `Key` fields we consult — declared structurally so this stays Ink-free. */
export interface InputKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean; // Ink folds Option/Alt into `meta`
  backspace?: boolean;
  delete?: boolean; // a plain Backspace press arrives as `delete` in Ink
}

const isSpace = (ch: string): boolean => /\s/.test(ch);

/** Start of the word at/just before `cursor`: skip trailing spaces, then word chars. */
function prevWordStart(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && isSpace(value[i - 1]!)) i--;
  while (i > 0 && !isSpace(value[i - 1]!)) i--;
  return i;
}

/** End of the word at/just after `cursor`: skip leading spaces, then word chars. */
function nextWordEnd(value: string, cursor: number): number {
  const n = value.length;
  let i = cursor;
  while (i < n && isSpace(value[i]!)) i++;
  while (i < n && !isSpace(value[i]!)) i++;
  return i;
}

const clamp = (n: number, hi: number): number => Math.max(0, Math.min(hi, n));

/** Apply one edit intent. Always returns a new state; out-of-range edits are no-ops. */
export function reduce(state: EditState, intent: EditIntent): EditState {
  const { value, cursor } = state;
  switch (intent.type) {
    case 'insert':
      return {
        value: value.slice(0, cursor) + intent.text + value.slice(cursor),
        cursor: cursor + intent.text.length,
      };
    case 'left':
      return { value, cursor: clamp(cursor - 1, value.length) };
    case 'right':
      return { value, cursor: clamp(cursor + 1, value.length) };
    case 'wordLeft':
      return { value, cursor: prevWordStart(value, cursor) };
    case 'wordRight':
      return { value, cursor: nextWordEnd(value, cursor) };
    case 'home':
      return { value, cursor: 0 };
    case 'end':
      return { value, cursor: value.length };
    case 'deleteBack':
      if (cursor === 0) return state;
      return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
    case 'deleteWordBack': {
      if (cursor === 0) return state;
      const start = prevWordStart(value, cursor);
      return { value: value.slice(0, start) + value.slice(cursor), cursor: start };
    }
    case 'killToStart':
      return { value: value.slice(cursor), cursor: 0 };
    case 'killToEnd':
      return { value: value.slice(0, cursor), cursor };
    default:
      return state;
  }
}

/**
 * Map an Ink keystroke to an edit intent, or `null` for keys the input must NOT
 * consume — `↑/↓` (history), `Tab`/`Shift+Tab` (suggestions / permission mode),
 * `Enter`, `Esc`, and `Ctrl+C` all fall through to App-level handlers.
 */
export function keyToIntent(input: string, key: InputKey): EditIntent | null {
  if (key.return || key.tab || key.upArrow || key.downArrow || key.escape) return null;
  if (key.ctrl) {
    switch (input) {
      case 'a':
        return { type: 'home' };
      case 'e':
        return { type: 'end' };
      case 'u':
        return { type: 'killToStart' };
      case 'k':
        return { type: 'killToEnd' };
      case 'w':
        return { type: 'deleteWordBack' };
      default:
        return null; // Ctrl+C and other combos belong to App
    }
  }
  if (key.leftArrow) return key.meta ? { type: 'wordLeft' } : { type: 'left' };
  if (key.rightArrow) return key.meta ? { type: 'wordRight' } : { type: 'right' };
  if (key.backspace || key.delete) return key.meta ? { type: 'deleteWordBack' } : { type: 'deleteBack' };
  // Printable text (space included). Meta-prefixed chars (e.g. Option+letter) are ignored.
  if (input && !key.meta) return { type: 'insert', text: input };
  return null;
}
