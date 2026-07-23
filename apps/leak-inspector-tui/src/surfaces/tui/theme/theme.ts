import { color } from './palette';

/**
 * Colour-map shape returned by getTheme(). Keys match the palette so consumers
 * can destructure a resolved theme without knowing whether auto resolved to
 * dark or light.
 */
export interface Theme {
  accent: string;
  accentDim: string;
  system: string;
  success: string;
  error: string;
  warning: string;
  violet: string;
  subtle: string;
}

/** Supported theme identifiers. 'dark' is the only variant for now. */
export type ThemeName = 'dark' | (string & {});

const THEMES: Record<string, Theme> = {
  dark: {
    accent: color.accent,
    accentDim: color.accentDim,
    system: color.system,
    success: color.success,
    error: color.error,
    warning: color.warning,
    violet: color.violet,
    subtle: color.subtle,
  },
};

/**
 * Resolve a theme name to its colour map. Falls back to 'dark' for unknown
 * names so callers always get a valid Theme.
 */
export function getTheme(themeName: ThemeName): Theme {
  return THEMES[themeName] ?? THEMES.dark;
}
