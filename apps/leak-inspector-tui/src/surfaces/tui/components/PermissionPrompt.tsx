import { Box, Text, useInput } from 'ink';
import { color, glyph } from '../theme';
import type { PendingPermission } from '../store';

/**
 * Permission prompt rendered as a sibling overlay above the input (not inside
 * the message list). Shown when a tool requests interactive approval; resolves
 * the pending promise on y/n.
 */
export function PermissionPrompt({ pending }: { pending: PendingPermission }) {
  useInput((input, key) => {
    if (input === 'y' || key.return) pending.resolve('allow');
    else if (input === 'n' || key.escape) pending.resolve('deny');
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color.system} paddingX={1}>
      <Text color={color.system} bold>
        {glyph.mark} permission required
      </Text>
      <Text>
        Run <Text bold>{pending.name}</Text>
        <Text dimColor>{summarize(pending.input)}</Text>?
      </Text>
      <Text dimColor>
        <Text color={color.success}>[y]</Text> allow {glyph.bullet} <Text color={color.error}>[n]</Text> deny{' '}
        {glyph.bullet} <Text color={color.violet}>shift+tab</Text> auto-accept
      </Text>
    </Box>
  );
}

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  try {
    const s = JSON.stringify(input);
    return s.length > 80 ? ` ${s.slice(0, 80)}…` : ` ${s}`;
  } catch {
    return '';
  }
}
