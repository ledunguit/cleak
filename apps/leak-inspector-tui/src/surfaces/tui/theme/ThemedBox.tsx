/**
 * Theme-aware wrapper around Ink `<Box>` that resolves semantic theme keys
 * (`'accent'`, `'error'`, etc.) for border colors.
 *
 * Usage:
 * ```tsx
 * import ThemedBox from './theme/ThemedBox';
 *
 * <ThemedBox borderColor="accent" borderStyle="round">…</ThemedBox>
 * <ThemedBox borderColor="#ff0">…</ThemedBox>              -- raw hex passthrough
 * <ThemedBox borderStyle="round">…</ThemedBox>              -- non-color passthrough
 * ```
 */
import React from 'react';
import { Box } from 'ink';
import { useTheme } from './ThemeProvider';
import { getTheme, type Theme } from './theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Color-related Box props that our wrapper overrides to accept theme keys. */
type ColorProp =
  | 'borderColor'
  | 'borderTopColor'
  | 'borderBottomColor'
  | 'borderLeftColor'
  | 'borderRightColor';

type InkBoxProps = React.ComponentProps<typeof Box>;

export interface ThemedBoxProps extends Omit<InkBoxProps, ColorProp> {
  borderColor?: keyof Theme | string;
  borderTopColor?: keyof Theme | string;
  borderBottomColor?: keyof Theme | string;
  borderLeftColor?: keyof Theme | string;
  borderRightColor?: keyof Theme | string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * If `value` is a raw color string (`#hex`, `rgb(`, `ansi256(`, `ansi:`) pass
 * through unchanged. Otherwise treat it as a `keyof Theme` and look up the
 * resolved hex from the current theme.
 */
function resolveColor(value: string | undefined, theme: Theme): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.startsWith('#') ||
    value.startsWith('rgb(') ||
    value.startsWith('ansi256(') ||
    value.startsWith('ansi:')
  ) {
    return value;
  }
  return theme[value as keyof Theme] ?? value;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * A theme-aware `<Box>` — drop-in replacement that also accepts semantic theme
 * keys (`'accent'`, `'error'`, …) in addition to raw Ink color strings.
 */
export default function ThemedBox(props: ThemedBoxProps) {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  const {
    borderColor,
    borderTopColor,
    borderBottomColor,
    borderLeftColor,
    borderRightColor,
    ...rest
  } = props;

  return (
    <Box
      borderColor={resolveColor(borderColor, theme)}
      borderTopColor={resolveColor(borderTopColor, theme)}
      borderBottomColor={resolveColor(borderBottomColor, theme)}
      borderLeftColor={resolveColor(borderLeftColor, theme)}
      borderRightColor={resolveColor(borderRightColor, theme)}
      {...rest}
    />
  );
}
