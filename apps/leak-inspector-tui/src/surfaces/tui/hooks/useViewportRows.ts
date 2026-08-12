import { useTerminalSize } from './useTerminalSize';

/**
 * Rows available to the main message viewport (and its scroll math).
 *
 * Single source of truth for the `termRows - 20` overhead that was previously
 * duplicated across App.tsx / MessageList.tsx / EvalScreen.tsx. The overhead
 * accounts for the sticky header (logo banner + agent breadcrumb) and the
 * sticky bottom block (status/spinner + phase timeline + prompt + agent list +
 * footer) plus inter-region margins.
 */
export const VIEWPORT_OVERHEAD = 20;

export function useViewportRows(min = 8, overhead = VIEWPORT_OVERHEAD): number {
  const { rows: termRows } = useTerminalSize();
  return Math.max(min, termRows - overhead);
}
