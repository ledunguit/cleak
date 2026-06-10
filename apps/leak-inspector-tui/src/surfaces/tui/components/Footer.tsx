import { Box, Text } from 'ink';
import { color, glyph } from '../theme';
import type { UiState } from '../store';

export function Footer({ state }: { state: UiState }) {
  const tokens = state.usage.inputTokens + state.usage.outputTokens;
  const chips: Array<[string, string]> = [
    [`${state.provider}:${state.model || '?'}`, color.accent],
    [`mode ${state.mode}`, color.subtle],
    [`dyn ${state.dynamic}`, color.subtle],
  ];
  if (state.currentPhase) chips.push([state.currentPhase, color.system]);
  if (tokens > 0) chips.push([`${state.usage.inputTokens}/${state.usage.outputTokens} tok`, color.subtle]);

  return (
    <Box flexDirection="row" flexWrap="wrap">
      {chips.map(([label, c], i) => (
        <Text key={label}>
          {i > 0 ? <Text color={color.subtle}> {glyph.bullet} </Text> : null}
          <Text color={c}>{label}</Text>
        </Text>
      ))}
    </Box>
  );
}
