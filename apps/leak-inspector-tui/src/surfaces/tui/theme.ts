/**
 * Terminal design system: a security-scanner palette + glyph set. The accent is
 * a cyan/teal (a "cyber console" cue rather than a warm/brand orange), with a
 * violet for system/permission and a clear severity ramp (emerald → amber →
 * rose) for safe / likely / critical findings. Colours are hex so they render on
 * truecolor terminals via ink.
 */

export const color = {
  accent: '#22D3EE', // cyan — brand accent (markers, prompt, logo, spinner)
  accentDim: '#0E7490',
  system: '#A78BFA', // violet — system / permission
  success: '#34D399', // emerald — safe / confirmed-clean / ok
  error: '#FB7185', // rose — critical / error / confirmed leak
  warning: '#FBBF24', // amber — likely / warning
  violet: '#C084FC', // elevated / auto-accept
  subtle: '#64748B', // slate — secondary text
} as const;

export const glyph = {
  /** Message / tool marker. */
  mark: process.platform === 'darwin' ? '⏺' : '●',
  /** Spinner + brand star. */
  star: '✻',
  /** Tool-result tree connector. */
  tree: '⎿',
  /** User prompt pointer. */
  pointer: '❯',
  tick: '✔',
  cross: '✗',
  bullet: '·',
  running: '◐',
} as const;

export const SPINNER_FRAMES = ['✶', '✸', '✹', '✺', '✹', '✷'];
