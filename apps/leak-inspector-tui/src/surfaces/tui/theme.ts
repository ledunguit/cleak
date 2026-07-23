/**
 * Barrel re-export — every import path that was `from './theme'` or
 * `from '../theme'` continues to resolve here and gets everything from the
 * new `theme/` module.
 *
 * New code may import directly from `theme/` for the provider/hooks or
 * from `theme/palette` / `theme/theme` / `theme/ThemeProvider`.
 */

export {
  color,
  glyph,
  SPINNER_FRAMES,
  formatDuration,
  getTheme,
  ThemeProvider,
  useTheme,
  useThemeSetting,
} from './theme/index';
export type { Theme, ThemeName, ThemeSetting, ThemeContextValue, ThemeProviderProps } from './theme/index';
