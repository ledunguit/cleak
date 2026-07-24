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
  /** Sidebar width in columns (default 32). */
  readonly sidebarWidth?: number;
}

/**
 * Three-region layout: sticky header, body (sidebar + content), sticky bottom.
 *
 * The sidebar is rendered on the left or right based on `sidebarPosition`.
 * The content area fills remaining space with overflow hidden (scroll clipping).
 */
export function MainLayout({
  header,
  sidebar,
  content,
  bottom,
  sidebarPosition = 'right',
  sidebarWidth = 32,
}: MainLayoutProps) {
  const sidebarBox = (
    <Box width={sidebarWidth} flexShrink={0} flexDirection="column" overflow="hidden">
      {sidebar}
    </Box>
  );

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* Sticky header */}
      <Box flexShrink={0} flexDirection="column">
        {header}
      </Box>

      {/* Body: sidebar + content */}
      <Box flexGrow={1} flexDirection="row" overflow="hidden">
        {sidebarPosition === 'left' && sidebarBox}
        <Box flexGrow={1} flexDirection="column" overflow="hidden">
          {content}
        </Box>
        {sidebarPosition === 'right' && sidebarBox}
      </Box>

      {/* Sticky bottom */}
      <Box flexShrink={0} flexDirection="column">
        {bottom}
      </Box>
    </Box>
  );
}
