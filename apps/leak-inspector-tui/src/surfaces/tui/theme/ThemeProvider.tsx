import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ThemeName } from './theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw theme preference stored in the context. 'auto' resolves to 'dark'
 * until we add system-preference detection. */
export type ThemeSetting = 'auto' | ThemeName;

export interface ThemeContextValue {
  /** The raw stored preference (may be 'auto'). */
  themeSetting: ThemeSetting;
  /** Persist a new theme preference. Clears any active preview. */
  setThemeSetting: (setting: ThemeSetting) => void;
  /** Resolved concrete theme name — never 'auto'. */
  currentTheme: ThemeName;
  /** Temporarily switch to a different theme for live preview. */
  setPreviewTheme: (theme: ThemeName) => void;
  /** Accept the current preview as the saved preference. */
  savePreview: () => void;
  /** Revert the preview and go back to the saved theme. */
  cancelPreview: () => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ThemeProviderProps {
  children: React.ReactNode;
  /** Optional initial theme setting. Defaults to 'auto'. */
  initialSetting?: ThemeSetting;
}

/** Resolve a ThemeSetting to a concrete ThemeName. 'auto' → 'dark' for now. */
function resolveTheme(setting: ThemeSetting): ThemeName {
  if (setting === 'auto') return 'dark';
  return setting;
}

/**
 * Provides theme context to the Ink app tree.
 *
 * - `useTheme()` → `[currentTheme]` — the resolved theme name
 * - `useThemeSetting()` → the raw setting ('auto', 'dark', …)
 * - The context also exposes {@link ThemeContextValue} for advanced usage
 *   (preview, save, cancel).
 */
export function ThemeProvider({ children, initialSetting = 'auto' }: ThemeProviderProps) {
  const [savedSetting, setSavedSetting] = useState<ThemeSetting>(initialSetting);
  const [previewTheme, setPreviewTheme] = useState<ThemeName | null>(null);

  const currentTheme: ThemeName = previewTheme ?? resolveTheme(savedSetting);

  const setThemeSetting = useCallback((setting: ThemeSetting) => {
    setSavedSetting(setting);
    setPreviewTheme(null);
  }, []);

  const savePreview = useCallback(() => {
    if (previewTheme) {
      setSavedSetting(previewTheme);
      setPreviewTheme(null);
    }
  }, [previewTheme]);

  const cancelPreview = useCallback(() => {
    setPreviewTheme(null);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeSetting: savedSetting,
      setThemeSetting,
      currentTheme,
      setPreviewTheme,
      savePreview,
      cancelPreview,
    }),
    [savedSetting, currentTheme, setThemeSetting, setPreviewTheme, savePreview, cancelPreview],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Convenience hook: returns the resolved theme name as a single-element tuple.
 *
 * ```ts
 * const [theme] = useTheme();
 * // theme → 'dark'
 * ```
 */
export function useTheme(): [ThemeName] {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a <ThemeProvider>');
  return [ctx.currentTheme];
}

/**
 * Returns the raw theme setting string ('auto', 'dark', …).
 * Use this when you need the user's preference, not the resolved value.
 */
export function useThemeSetting(): ThemeSetting {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useThemeSetting must be used within a <ThemeProvider>');
  return ctx.themeSetting;
}
