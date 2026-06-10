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
  /** Sending a request to the model. */
  arrowUp: '↑',
  /** Receiving the streamed response. */
  arrowDown: '↓',
  /** Collapsed (click to expand) / expanded disclosure markers. */
  collapsed: '▶',
  expanded: '▼',
} as const;

export const SPINNER_FRAMES = ['✶', '✸', '✹', '✺', '✹', '✷'];

/**
 * Human-readable elapsed time: seconds under a minute, `Nm Ss` under an hour,
 * `Hh Mm` beyond. Used for the running spinner and scan metrics.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}
