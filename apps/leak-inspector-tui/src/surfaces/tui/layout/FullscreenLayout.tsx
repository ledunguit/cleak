import type { ReactNode, RefObject } from 'react';
import { Box, Text, useStdout } from 'ink';
import { StackLayout } from './StackLayout.js';
import { isFullscreenEnvEnabled } from './layoutFlags.js';

export interface FullscreenLayoutProps {
  /** Optional header — rendered at the top with flexShrink:0 */
  readonly header?: ReactNode;

  /** Main scrollable content area (flexGrow) */
  readonly scrollable?: ReactNode;

  /** Pinned bottom bar (flexShrink:0) */
  readonly bottom?: ReactNode;

  /** Floating overlay — absolutely positioned on top of everything */
  readonly modal?: ReactNode;

  /** Ref forwarded to the scrollable content Box */
  readonly scrollRef?: RefObject<unknown>;

  /** Ref forwarded to the divider marker (for "new messages" line) */
  readonly dividerYRef?: RefObject<unknown>;

  /** Number of new/unseen messages to display in the pill badge */
  readonly newMessageCount?: number;

  /** Callback when the "N new messages" pill is activated (e.g. Enter pressed) */
  readonly onPillClick?: () => void;

  /** Force-hide the pill badge (e.g. when user is at the bottom) */
  readonly hidePill?: boolean;
}

/**
 * Fullscreen-aware layout wrapper around StackLayout.
 *
 * Features:
 * - Calculates viewport from terminal dimensions via `useStdout`
 * - Wraps content in a viewport-constrained Box when `isFullscreenEnvEnabled()` is true
 * - Renders a "N new messages" pill overlay when scrolled up and new messages arrive
 * - Falls back to plain StackLayout when fullscreen is disabled
 *
 * Viewport formula (matching App.tsx): `Math.max(8, rows - 12)`
 */
export function FullscreenLayout({
  header,
  scrollable,
  bottom,
  modal,
  scrollRef,
  dividerYRef,
  newMessageCount = 0,
  onPillClick: _onPillClick,
  hidePill = false,
}: FullscreenLayoutProps) {
  // Fallback: when fullscreen is not enabled, delegate to StackLayout as-is
  if (!isFullscreenEnvEnabled()) {
    return (
      <StackLayout
        header={header}
        scrollable={scrollable}
        bottom={bottom}
        modal={modal}
      />
    );
  }

  const { stdout } = useStdout();
  const terminalRows = Math.max(12, stdout.rows ?? 30);

  // Show "N new messages" pill when scrolled up and there are new items
  const showPill = !hidePill && newMessageCount > 0;

  return (
    <Box flexDirection="column" width="100%" height={terminalRows}>
      <StackLayout
        header={header}
        scrollable={
          <Box
            ref={scrollRef as RefObject<unknown>}
            flexDirection="column"
            overflow="hidden"
            position="relative"
          >
            {scrollable}

            {/* Invisible marker for parent to track divider Y position */}
            {dividerYRef && (
              <Box ref={dividerYRef as RefObject<unknown>} />
            )}

            {/* "N new messages" pill — floating badge centered at the bottom */}
            {showPill && (
              <Box
                position="absolute"
                bottom={0}
                width="100%"
                justifyContent="center"
              >
                <Box backgroundColor="#2563eb" paddingX={1}>
                  <Text color="white">
                    {newMessageCount} new message
                    {newMessageCount !== 1 ? 's' : ''}
                  </Text>
                </Box>
              </Box>
            )}
          </Box>
        }
        bottom={bottom}
        modal={modal}
      />
    </Box>
  );
}
