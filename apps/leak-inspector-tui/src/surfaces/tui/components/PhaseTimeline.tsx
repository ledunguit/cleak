import { Box, Text } from 'ink';
import { SCAN_PHASE_ORDER, PHASE_META, ScanPhase } from '@cleak/common/flow/scan-flow-contract';
import { color, glyph } from '../theme';
import type { PhaseStatus, UiState } from '../store';

const ICON: Record<PhaseStatus, string> = {
  pending: '○',
  active: glyph.running,
  done: glyph.mark,
  skipped: glyph.bullet,
  failed: glyph.cross,
};
const COLOR: Record<PhaseStatus, string> = {
  pending: color.subtle,
  active: color.warning,
  done: color.success,
  skipped: color.subtle,
  failed: color.error,
};

export function PhaseTimeline({ phases }: { phases: UiState['phases'] }) {
  return (
    <Box flexDirection="row" flexWrap="wrap">
      {SCAN_PHASE_ORDER.map((p: ScanPhase, idx) => (
        <Text key={p} color={COLOR[phases[p]]}>
          {idx > 0 ? <Text color={color.subtle}> {glyph.bullet} </Text> : null}
          {ICON[phases[p]]} {PHASE_META[p].title}
        </Text>
      ))}
    </Box>
  );
}
