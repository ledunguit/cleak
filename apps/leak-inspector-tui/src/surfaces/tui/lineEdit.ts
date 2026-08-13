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

/** lineEdit now re-exports from PromptInput/keybindings module to avoid duplication.
 *  The implementations live in components/PromptInput/keybindings. */

// Re-export from PromptInput/keybindings for backward compatibility.
export { keyToIntent, reduce } from './components/PromptInput/keybindings';
