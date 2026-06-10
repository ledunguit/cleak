/**
 * Compact retro block-font banner (3 rows, 3-wide glyphs) for the "LEAK
 * INVESTIGATOR" wordmark. Hand-defined for exact alignment; rendered in the
 * brand accent by the Welcome header. Small enough to sit on a single line.
 */

const FONT: Record<string, [string, string, string]> = {
  L: ['█  ', '█  ', '███'],
  E: ['███', '██ ', '███'],
  A: ['███', '███', '█ █'],
  K: ['█ █', '██ ', '█ █'],
  I: ['███', ' █ ', '███'],
  N: ['█▖█', '███', '█ █'],
  V: ['█ █', '█ █', ' █ '],
  S: ['███', '▀▀▄', '▄▄█'],
  T: ['███', ' █ ', ' █ '],
  G: ['███', '█▄█', '███'],
  O: ['███', '█ █', '███'],
  R: ['██ ', '██▖', '█ █'],
  ' ': ['  ', '  ', '  '],
};

/** Render `text` as a 3-line block banner (each glyph separated by one space). */
export function renderBanner(text: string): string[] {
  const rows = ['', '', ''];
  const chars = text.toUpperCase().split('');
  chars.forEach((ch, i) => {
    const glyph = FONT[ch] ?? FONT[' '];
    for (let r = 0; r < 3; r++) rows[r] += (i > 0 ? ' ' : '') + glyph[r];
  });
  return rows;
}
