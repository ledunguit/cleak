import { Box, Text } from 'ink';
import { memo } from 'react';
import { color, glyph } from '../theme';
import type { UiState } from '../store';

export const Footer = memo(function Footer({ state }: { state: UiState }) {
  const { inputTokens, outputTokens, thinkingTokens } = state.usage;
  const auto = state.permissionMode === 'auto';
  const chips: Array<[string, string]> = [
    [`${state.provider}:${state.model || '?'}`, color.accent],
    [`mode ${state.mode}`, color.subtle],
    [`dyn ${state.dynamic}`, color.subtle],
    [auto ? 'accept: auto ⏵' : 'accept: ask', auto ? color.violet : color.subtle],
  ];
  if (state.currentPhase) chips.push([state.currentPhase, color.system]);
  if (inputTokens + outputTokens > 0) {
    const think = thinkingTokens > 0 ? ` / ${thinkingTokens} think` : '';
    chips.push([`${inputTokens} in / ${outputTokens} out${think} tok`, color.subtle]);
  }

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
});
