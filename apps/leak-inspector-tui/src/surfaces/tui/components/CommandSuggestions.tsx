import { Box, Text } from 'ink';
import { color, glyph } from '../theme';
import type { CommandSpec } from '../commands';

/** Typeahead list shown under the prompt while the input starts with `/`. */
export function CommandSuggestions({ commands, index }: { commands: CommandSpec[]; index: number }) {
  if (commands.length === 0) return null;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {commands.map((c, i) => {
        const hot = i === index;
        return (
          <Text key={c.name}>
            <Text color={hot ? color.accent : color.subtle}>{hot ? glyph.pointer : ' '} </Text>
            <Text bold color={hot ? color.accent : undefined}>
              {c.name}
            </Text>
            {c.kind === 'select' ? <Text color={color.system}> ▾</Text> : null}
            <Text dimColor> {glyph.bullet} {c.summary}</Text>
          </Text>
        );
      })}
      <Text dimColor> tab to complete · ↑/↓ to choose</Text>
    </Box>
  );
}
