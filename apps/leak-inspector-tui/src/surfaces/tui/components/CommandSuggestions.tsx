import { Box, Text } from 'ink';
import { memo } from 'react';
import ThemedText from '../theme/ThemedText';
import { glyph } from '../theme';
import type { CommandSpec } from '../commands';

/** Typeahead list shown under the prompt while the input starts with `/`. */
export const CommandSuggestions = memo(function CommandSuggestions({ commands, index }: { commands: CommandSpec[]; index: number }) {
  if (commands.length === 0) return null;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {commands.map((c, i) => {
        const hot = i === index;
        return (
          <Text key={c.name}>
            <ThemedText color={hot ? 'accent' : 'subtle'}>{hot ? glyph.pointer : ' '} </ThemedText>
            <ThemedText bold color={hot ? 'accent' : undefined}>
              {c.name}
            </ThemedText>
            {c.kind === 'select' ? <ThemedText color="system"> ▾</ThemedText> : null}
            <Text dimColor> {glyph.bullet} {c.summary}</Text>
          </Text>
        );
      })}
      <Text dimColor> tab to complete · ↑/↓ to choose</Text>
    </Box>
  );
});
