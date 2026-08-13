/**
 * Bracketed-paste support for the prompt input.
 *
 * Bracketed paste mode (`\x1b[?2004h` / `\x1b[?2004l`) lets terminals wrap
 * pasted text in `\x1b[200~` … `\x1b[201~` delimiters so the application can
 * distinguish pasted input from typed keystrokes. This hook:
 *
 *   1. Checks whether the terminal is likely to support it (TERM, isTTY).
 *   2. Writes the enable sequence to stdout on mount.
 *   3. Writes the disable sequence on unmount (clean-up).
 *   4. Exposes `consumePaste(input)` — feeds each useInput chunk through the
 *      paste buffer and returns the completed pasted text when a full
 *      bracketed paste (`[200~` … `\x1b[201~`) has arrived.
 *
 * Ink delivers a multi-character paste as a single `useInput` chunk with the
 * delimiters intact (its keypress parser strips the leading `\x1b`), so a
 * paste is normally completed in one call. The buffered path also covers
 * terminals that split the paste across several data chunks.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const BRACKETED_PASTE_ENABLE = '\x1b[?2004h';
const BRACKETED_PASTE_DISABLE = '\x1b[?2004l';
const PASTE_START = '[200~';
const PASTE_END = '\x1b[201~';

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
 * Subscribe to paste-support lifecycle + chunk buffering.
 *
 * On mount: writes the bracketed-paste enable sequence to stdout.
 * On unmount: writes the disable sequence.
 *
 * `consumePaste(input)` returns:
 *   - `null` when `input` is not part of a bracketed paste (normal typing),
 *   - `''` when it was consumed but a paste is still buffering,
 *   - the completed pasted text when a full paste has arrived.
 */
export function usePasteSupport(): {
  pasteSupported: boolean;
  consumePaste: (input: string) => string | null;
} {
  const [pasteSupported] = useState(detectPasteCapability);
  const buffer = useRef('');
  const pasting = useRef(false);

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

  const consumePaste = useCallback((input: string): string | null => {
    if (pasting.current) {
      const close = input.indexOf(PASTE_END);
      if (close >= 0) {
        buffer.current += input.slice(0, close);
        const done = buffer.current;
        buffer.current = '';
        pasting.current = false;
        return done;
      }
      buffer.current += input;
      return '';
    }
    const start = input.indexOf(PASTE_START);
    if (start < 0) return null;
    const rest = input.slice(start + PASTE_START.length);
    const close = rest.indexOf(PASTE_END);
    if (close >= 0) return rest.slice(0, close);
    pasting.current = true;
    buffer.current = rest;
    return '';
  }, []);

  return { pasteSupported, consumePaste };
}
