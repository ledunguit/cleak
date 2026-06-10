import { Box, Text } from 'ink';
import { color, glyph } from '../theme';
import type { AgentInfo, UiState } from '../store';

const STATUS_ICON: Record<AgentInfo['status'], string> = {
  running: glyph.running,
  done: glyph.mark,
  error: glyph.cross,
};
const STATUS_COLOR: Record<AgentInfo['status'], string> = {
  running: color.warning,
  done: color.success,
  error: color.error,
};

/**
 * The sub-agent list shown under the input while in the main flow. Pressing ↓ from
 * the main flow drops the cursor in here (navMode 'agentlist'); Enter opens an
 * agent's detailed log. Hidden when there are no sub-agents or when already viewing
 * one agent's log.
 */
export function AgentList({ state }: { state: UiState }) {
  if (state.agents.length === 0 || state.viewAgentId !== 'main') return null;
  const active = state.navMode === 'agentlist';
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color.subtle} dimColor>
        {glyph.bullet} agents ({state.agents.length}) {glyph.bullet}{' '}
        {active ? '↑/↓ choose · enter open · ← back' : '↓ to browse agents'}
      </Text>
      {state.agents.map((a, i) => {
        const hot = active && i === state.navIndex;
        return (
          <Text key={a.id}>
            <Text color={hot ? color.accent : color.subtle}>{hot ? glyph.pointer : ' '} </Text>
            <Text color={STATUS_COLOR[a.status]}>{STATUS_ICON[a.status]} </Text>
            <Text bold color={hot ? color.accent : undefined}>{a.label}</Text>
            <Text dimColor> {glyph.bullet} {a.status} {glyph.bullet} {a.turns} turn{a.turns === 1 ? '' : 's'}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
