/**
 * Detail view for a single finding — thin wrapper that extracts the detail-tab
 * content from the old monolithic FindingsScreen. Renders the position context
 * ("finding N of M · report.html") above a full VerdictCard so the user sees
 * the structured verdict, evidence, static analysis, and repair diff for the
 * selected candidate. Stateless — the parent owns cursor/tab state.
 */
import { Box, Text } from 'ink';
import { glyph } from '../theme';
import { VerdictCard } from './VerdictCard';
import type { FindingView } from '../findings/findingView';

export function FindingsDetail({
  finding,
  cursor,
  total,
  reportPath,
}: {
  finding: FindingView;
  cursor: number;
  total: number;
  reportPath: string;
}) {
  return (
    <Box flexDirection="column">
      <Text dimColor>
        finding {cursor + 1} of {total} {glyph.bullet} {reportPath}
      </Text>
      <Box marginTop={1}>
        <VerdictCard
          f={finding}
          width={Math.min(110, (process.stdout.columns ?? 100) - 2)}
        />
      </Box>
    </Box>
  );
}
