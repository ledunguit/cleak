import type { ReactNode } from 'react';
import { Box } from 'ink';

export interface StackLayoutProps {
  /** Optional top bar — rendered at the top with flexShrink:0 */
  readonly header?: ReactNode;

  /** FlexGrow scroll area — the main content region */
  readonly scrollable?: ReactNode;

  /** Pinned footer — rendered below scrollable with flexShrink:0 */
  readonly bottom?: ReactNode;

  /** Floating overlay — absolutely positioned on top of everything */
  readonly modal?: ReactNode;
}

/**
 * Basic scroll/pin/modal layout primitive for the Ink TUI.
 *
 * Renders in a single column:
 *   header (optional, flexShrink:0)
 *   → scrollable (flexGrow:1, overflow:hidden)
 *   → bottom   (optional, flexShrink:0)
 *
 * When `modal` is provided, it is rendered as an absolutely-positioned
 * overlay on top of the entire stack.
 *
 * This component uses only Ink's built-in Box components — no custom
 * ScrollBox, no virtual scrolling. It works inline without fullscreen
 * mode (see layoutFlags.ts for the fullscreen opt-in toggle).
 */
export function StackLayout({ header, scrollable, bottom, modal }: StackLayoutProps) {
  return (
    <Box flexDirection="column" width="100%" height="100%">
      {header && (
        <Box flexShrink={0}>
          {header}
        </Box>
      )}

      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        {scrollable}
      </Box>

      {bottom && (
        <Box flexShrink={0} flexDirection="column">
          {bottom}
        </Box>
      )}

      {modal && (
        <Box position="absolute" width="100%" height="100%">
          {modal}
        </Box>
      )}
    </Box>
  );
}
