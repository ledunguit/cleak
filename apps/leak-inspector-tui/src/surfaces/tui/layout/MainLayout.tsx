import type { ReactNode } from 'react';
import { Box } from 'ink';

export interface MainLayoutProps {
  /** Sticky top — logo banner + provider info. */
  readonly header: ReactNode;
  /** Sidebar — tips + recent scans. Position controlled by sidebarPosition. */
  readonly sidebar: ReactNode;
  /** Main content area — messages (scrollable). */
  readonly content: ReactNode;
  /** Sticky bottom — timeline + input + footer. */
  readonly bottom: ReactNode;
  /** Which side the sidebar sits on. */
  readonly sidebarPosition?: 'left' | 'right';
  /** Terminal columns (from useStdout). Used for responsive sidebar width. */
  readonly termCols?: number;
  /** Terminal rows (from useStdout). Constrains total layout height. */
  readonly termRows?: number;
}

/**
 * Three-region layout: sticky header, body (sidebar + content), sticky bottom.
 *
 * The sidebar is rendered on the left or right based on `sidebarPosition`.
 * The content area fills remaining space with overflow hidden (scroll clipping).
 * Sidebar width is responsive: 30% of terminal width, clamped to [24, 36].
 * Below SIDEBAR_MIN_COLS the sidebar is hidden entirely so narrow terminals
 * get the full content width.
 */

/** Below this many terminal columns the sidebar is dropped (content goes full width). */
export const SIDEBAR_MIN_COLS = 100;

export function MainLayout({
  header,
  sidebar,
  content,
  bottom,
  sidebarPosition = 'right',
  termCols = 100,
  termRows = 24,
}: MainLayoutProps) {
  const sidebarWidth = Math.max(24, Math.min(36, Math.floor(termCols * 0.3)));
  const showSidebar = termCols >= SIDEBAR_MIN_COLS;

  const sidebarBox = (
    <Box width={sidebarWidth} flexShrink={0} flexDirection="column" overflow="hidden">
      {sidebar}
    </Box>
  );

  return (
    <Box flexDirection="column" width="100%" height={termRows}>
      {/* Sticky header */}
      <Box flexShrink={0} flexDirection="column">
        {header}
      </Box>

      {/* Body: sidebar + content */}
      <Box flexGrow={1} flexDirection="row" overflow="hidden">
        {sidebarPosition === 'left' && showSidebar && sidebarBox}
        <Box flexGrow={1} flexDirection="column" overflow="hidden">
          {content}
        </Box>
        {sidebarPosition === 'right' && showSidebar && sidebarBox}
      </Box>

      {/* Sticky bottom */}
      <Box flexShrink={0} flexDirection="column">
        {bottom}
      </Box>
    </Box>
  );
}
