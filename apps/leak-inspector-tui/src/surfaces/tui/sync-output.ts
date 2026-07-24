/**
 * DEC 2026 Synchronized Output — prevents visible flicker during Ink re-renders.
 *
 * Wraps process.stdout.write() in BSU/ESU sequences so the terminal either
 * shows the complete old frame or the complete new frame, never a partial state.
 *
 * Ink's log-update writes eraseLines(N) + newFrame as a single stream.write(),
 * so BSU/ESU naturally brackets a complete frame.
 *
 * Detection logic mirrors Claude Code's isSynchronizedOutputSupported().
 */

const BSU = '\x1b[?2026h'; // Begin Synchronized Update
const ESU = '\x1b[?2026l'; // End Synchronized Update

/** Check if the terminal supports DEC mode 2026 (synchronized output). */
export function isSynchronizedOutputSupported(): boolean {
  // tmux proxies bytes but doesn't implement DEC 2026 — BSU/ESU pass through
  // but tmux already breaks atomicity by chunking.
  if (process.env.TMUX) return false;

  const termProgram = process.env.TERM_PROGRAM;
  const term = process.env.TERM;

  // Modern terminals with known DEC 2026 support
  if (
    termProgram === 'iTerm.app' ||
    termProgram === 'WezTerm' ||
    termProgram === 'WarpTerminal' ||
    termProgram === 'ghostty' ||
    termProgram === 'contour' ||
    termProgram === 'vscode' ||
    termProgram === 'alacritty'
  ) {
    return true;
  }

  // kitty sets TERM=xterm-kitty or KITTY_WINDOW_ID
  if (term?.includes('kitty') || process.env.KITTY_WINDOW_ID) return true;

  // Ghostty may set TERM=xterm-ghostty without TERM_PROGRAM
  if (term === 'xterm-ghostty') return true;

  // foot sets TERM=foot or TERM=foot-extra
  if (term?.startsWith('foot')) return true;

  // Alacritty may set TERM containing 'alacritty'
  if (term?.includes('alacritty')) return true;

  // Zed uses the alacritty_terminal crate which supports DEC 2026
  if (process.env.ZED_TERM) return true;

  // Windows Terminal
  if (process.env.WT_SESSION) return true;

  // VTE-based terminals (GNOME Terminal, Tilix, etc.) since VTE 0.68
  const vteVersion = process.env.VTE_VERSION;
  if (vteVersion) {
    const version = parseInt(vteVersion, 10);
    if (version >= 6800) return true;
  }

  return false;
}

/**
 * Monkey-patch process.stdout.write to wrap every write in BSU/ESU.
 * Call ONCE at app startup, before any Ink render.
 *
 * This is the same approach Claude Code uses in writeDiffToTerminal(),
 * adapted for stock Ink which doesn't have a custom render pipeline.
 */
export function installSyncOutput(): boolean {
  if (!isSynchronizedOutputSupported()) return false;

  const originalWrite = process.stdout.write.bind(process.stdout);

  (process.stdout.write as any) = function (chunk: any, ...args: any[]) {
    if (typeof chunk === 'string' && chunk.length > 0) {
      return originalWrite(BSU + chunk + ESU, ...args);
    }
    return originalWrite(chunk, ...args);
  } as typeof process.stdout.write;

  return true;
}
