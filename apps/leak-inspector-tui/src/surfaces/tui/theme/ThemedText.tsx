import React, { type ReactNode } from 'react';
import { Text } from 'ink';
import { useTheme } from './ThemeProvider';
import { getTheme, type Theme } from './theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThemedTextProps {
  /**
   * A theme semantic key (e.g. "accent", "error", "subtle") or a raw hex
   * colour string. Theme keys are resolved to the corresponding hex value
   * from the current theme's colour map; raw strings pass through as-is.
   *
   * When neither `color` nor `dimColor` is set, no colour is passed to Ink's
   * `<Text>`, so the component inherits the ancestor's text colour.
   */
  color?: keyof Theme | string;

  /**
   * Render the text in the theme's `subtle` colour (slate). This is
   * intentionally **not** Ink's built-in `dimColor` prop, because Ink's
   * native dimming uses ANSI escape codes that conflict with `bold`.
   * When set, this takes precedence over the `color` prop.
   */
  dimColor?: boolean;

  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  /** Text-wrapping behaviour. Maps directly to Ink's `<Text wrap>`. */
  wrap?: 'wrap' | 'end' | 'middle' | 'truncate-end' | 'truncate' | 'truncate-middle' | 'truncate-start';

  /** Theme key or raw hex colour string for the background. */
  backgroundColor?: keyof Theme | string;

  children?: ReactNode;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a colour value that may be a theme key. */
function resolveColor(
  value: keyof Theme | string | undefined,
  theme: Theme,
): string | undefined {
  if (value == null) return undefined;
  // If the value is one of the known theme keys, resolve to its hex value.
  if (value in theme) return theme[value as keyof Theme];
  // Otherwise treat it as a raw colour string (hex / named).
  return value;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function ThemedText({
  color: colorProp,
  dimColor,
  bold,
  italic,
  underline,
  strikethrough,
  inverse,
  wrap,
  backgroundColor: bgProp,
  children,
}: ThemedTextProps) {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  // dimColor overrides the explicit `color` prop — it resolves to the
  // theme's `subtle` value, which is a solid hex colour, not an ANSI dim
  // escape code. This makes it compatible with `bold`.
  const resolvedColor = dimColor
    ? theme.subtle
    : resolveColor(colorProp, theme);

  const resolvedBg = resolveColor(bgProp, theme);

  return (
    <Text
      color={resolvedColor}
      backgroundColor={resolvedBg}
      bold={bold}
      italic={italic}
      underline={underline}
      strikethrough={strikethrough}
      inverse={inverse}
      wrap={wrap}
    >
      {children}
    </Text>
  );
}

export default ThemedText;
