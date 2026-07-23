import { getTheme, type Theme, type ThemeName } from './theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 'foreground' colors the text, 'background' colors behind it. */
export type ColorType = 'foreground' | 'background';

/**
 * A raw color value that Ink's `<Text color="...">` accepts.
 * - Hex: `#RGB` or `#RRGGBB`
 * - RGB: `rgb(r, g, b)`
 * - ANSI 256: `ansi256(n)`
 * - SGR pass-through: `ansi:<sgr-param>`  (e.g. `ansi:1` for bold)
 * - Named: chalk colour names like `'green'`, `'red'` (passed through unchanged)
 */
export type Color = string;

// ---------------------------------------------------------------------------
// Internal — ANSI helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';

/** Convert a hex colour to a truecolor ANSI SGR parameter. */
function hexToSgr(hex: string): string {
  const full = hex.length === 4
    ? hex[0] + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
    : hex;
  const r = parseInt(full.slice(1, 3), 16);
  const g = parseInt(full.slice(3, 5), 16);
  const b = parseInt(full.slice(5, 7), 16);
  return `38;2;${r};${g};${b}`;
}

// ---------------------------------------------------------------------------
// colorize — minimal ANSI wrapper (ink/chalk-free)
// ---------------------------------------------------------------------------

/**
 * Wraps `str` in ANSI 24-bit / ANSI 256 / SGR escape codes.
 *
 * This is a self-contained reimplementation of Ink's internal `colorize`
 * helper so we can use it **outside** JSX components (e.g. utility
 * functions, log formatting).  Ink does not export it publicly.
 *
 * Unrecognised colour values are silently ignored and the string is
 * returned unchanged.
 */
function colorize(str: string, color: string | undefined, type: ColorType): string {
  if (!color) return str;

  // 1. Named chalk colour — not supported without chalk, pass through
  //    (These include: 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan',
  //     'white', 'gray', 'black', 'redBright', … and ~150 extended names.)

  // 2. #hex — truecolor
  if (/^#[0-9a-fA-F]{3,6}$/.test(color)) {
    return `\x1b[${hexToSgr(color)}m${str}${RESET}`;
  }

  // 3. rgb(r, g, b) — truecolor
  const rgbMatch = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(color);
  if (rgbMatch) {
    const [_, r, g, b] = rgbMatch;
    const code = type === 'foreground' ? 38 : 48;
    return `\x1b[${code};2;${r};${g};${b}m${str}${RESET}`;
  }

  // 4. ansi256(n)
  const ansiMatch = /^ansi256\(\s*(\d+)\s*\)$/.exec(color);
  if (ansiMatch) {
    const code = type === 'foreground' ? 38 : 48;
    return `\x1b[${code};5;${ansiMatch[1]}m${str}${RESET}`;
  }

  // 5. ansi:<sgr-param> — raw pass-through (e.g. ansi:1 for bold)
  if (color.startsWith('ansi:')) {
    return `\x1b[${color.slice(5)}m${str}${RESET}`;
  }

  // Everything else — return uncolored
  return str;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Curried theme-aware colour function for use **outside** JSX.
 *
 * Resolves a theme key to a hex colour via `getTheme()` and wraps the
 * output text in ANSI escape codes so it renders with colour in the
 * terminal.  Also accepts raw colour values (`#hex`, `rgb(…)`, …) that
 * are passed through directly.
 *
 * ```ts
 * import { color } from '../theme/color';
 *
 * const accent = color('accent', 'dark');
 * console.log(accent('hello'));   // → '\x1b[38;2;34;211;238mhello\x1b[0m'
 *
 * // Raw hex
 * const raw = color('#FF0000', 'dark');
 * console.log(raw('danger'));     // → '\x1b[38;2;255;0;0mdanger\x1b[0m'
 *
 * // Background
 * const bg = color('accent', 'dark', 'background');
 * console.log(bg('highlight'));   // → '\x1b[48;2;34;211;238mhighlight\x1b[0m'
 *
 * // Undefined → no-op (no colour added)
 * const plain = color(undefined, 'dark');
 * console.log(plain('text'));     // → 'text'
 * ```
 *
 * @param c       Theme key, raw colour, or `undefined` (no-op).
 * @param theme   Theme name to resolve keys against.
 * @param type    `'foreground'` (default) or `'background'`.
 * @returns       A function that accepts text and returns the colourised string.
 */
export function color(
  c: keyof Theme | Color | undefined,
  theme: ThemeName,
  type: ColorType = 'foreground',
): (text: string) => string {
  return (text: string): string => {
    if (c == null) return text;

    // Raw colour string — pass through directly
    if (
      c.startsWith('#') ||
      c.startsWith('rgb(') ||
      c.startsWith('ansi256(') ||
      c.startsWith('ansi:')
    ) {
      return colorize(text, c, type);
    }

    // Theme key → resolve to hex then colourise
    const resolvedTheme = getTheme(theme);
    const raw = resolvedTheme[c as keyof Theme];
    if (raw == null) return text;

    return colorize(text, raw, type);
  };
}
