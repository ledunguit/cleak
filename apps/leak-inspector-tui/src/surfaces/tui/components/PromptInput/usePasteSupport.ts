/**
 * React hook that detects terminal bracketed-paste-mode support and enables it.
 *
 * Bracketed paste mode (`\x1b[?2004h` / `\x1b[?2004l`) lets terminals wrap pasted
 * text in `\x1b[200~` … `\x1b[201~` delimiters so the application can distinguish
 * pasted input from typed keystrokes.  This hook:
 *
 *   1. Checks whether the terminal is likely to support it (TERM, isTTY).
 *   2. Writes the enable sequence to stdout on mount.
 *   3. Writes the disable sequence on unmount (clean-up).
 *
 * Returns `{ pasteSupported }` — a static boolean the component can use to
 * conditionally show paste hints or enable alternative paste paths.
 *
 * > **Note:** Ink's `useInput` processes raw bytes through Node.js readline's
 * > `emitKeypressEvents`, so the `\x1b[200~` / `\x1b[201~` delimiters do NOT
 * > arrive as-is at the handler.  This hook only *enables* the mode so the
 * > terminal marks pasted text — actual paste handling must be done through a
 * > lower-level `data` listener or by inspecting the raw `input` parameter in
 * > `useInput` (the delimiters may appear as unrecognised key sequences).
 */

import { useEffect, useState } from 'react';

const BRACKETED_PASTE_ENABLE = '\x1b[?2004h';
const BRACKETED_PASTE_DISABLE = '\x1b[?2004l';

/** Known terminal type prefixes that support bracketed paste. */
const SUPPORTED_TERM_PATTERN = /^(xterm|kitty|alacritty|tmux|iterm|vscode)/i;

/**
 * True if the current terminal *likely* supports bracketed paste mode.
 * Checks `TERM` against known terminals and confirms `stdout` is a TTY.
 */
function detectPasteCapability(): boolean {
  // Not in a Node.js environment
  if (typeof process === 'undefined') return false;
  if (!process.stdout?.isTTY) return false;

  const term = process.env.TERM ?? '';
  if (!term) return false;

  return SUPPORTED_TERM_PATTERN.test(term);
}

/**
 * Subscribe to paste-support lifecycle.
 *
 * On mount: writes the bracketed-paste enable sequence to stdout.
 * On unmount: writes the disable sequence.
 *
 * The detection runs once (lazy initial state); no re-renders from the
 * stdout writes themselves.
 */
export function usePasteSupport(): { pasteSupported: boolean } {
  const [pasteSupported] = useState(detectPasteCapability);

  useEffect(() => {
    if (!pasteSupported) return;

    const stdout = process.stdout;
    // Enable bracketed paste mode
    stdout.write(BRACKETED_PASTE_ENABLE);

    return () => {
      // Disable on unmount / cleanup
      stdout.write(BRACKETED_PASTE_DISABLE);
    };
  }, [pasteSupported]);

  return { pasteSupported };
}
