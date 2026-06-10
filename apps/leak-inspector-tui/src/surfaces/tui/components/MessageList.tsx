import { Box, Text } from 'ink';
import { color, glyph } from '../theme';
import type { ToolCardData, UiMessage } from '../store';

const MAX_VISIBLE = 24;

export function MessageList({ messages }: { messages: UiMessage[] }) {
  const visible = messages.slice(-MAX_VISIBLE);
  return (
    <Box flexDirection="column">
      {visible.map((m) => (
        <Box key={m.id} marginBottom={m.kind === 'phase' ? 0 : 0}>
          <MessageRow message={m} />
        </Box>
      ))}
    </Box>
  );
}

function MessageRow({ message }: { message: UiMessage }) {
  switch (message.kind) {
    case 'user':
      return (
        <Text>
          <Text color={color.subtle}>{glyph.pointer} </Text>
          <Text>{message.text}</Text>
        </Text>
      );
    case 'thinking':
      return (
        <Text color={color.subtle}>
          {'  '}💭 {truncate(message.text ?? '', 400)}
        </Text>
      );
    case 'assistant':
      return (
        <Text>
          <Text color={color.accent}>{glyph.mark} </Text>
          <Text>{message.text}</Text>
        </Text>
      );
    case 'system':
      return message.color ? <Text color={message.color}>{message.text}</Text> : <Text dimColor>{message.text}</Text>;
    case 'phase':
      return <Text color={color.subtle}>{divider(message.text ?? '')}</Text>;
    case 'tool':
      return message.tool ? <ToolCard tool={message.tool} /> : null;
    default:
      return null;
  }
}

const SOURCE_LABEL: Record<ToolCardData['source'], string> = {
  'mcp-static': 'mcp·static',
  'mcp-dynamic': 'mcp·dynamic',
  local: 'local',
};

function ToolCard({ tool }: { tool: ToolCardData }) {
  const markColor =
    tool.status === 'running' ? color.warning : tool.status === 'error' ? color.error : color.success;
  const mark = tool.status === 'running' ? glyph.running : tool.status === 'error' ? glyph.cross : glyph.mark;
  const dur = tool.durationMs != null ? ` ${glyph.bullet} ${formatMs(tool.durationMs)}` : '';
  const badgeColor = tool.source === 'local' ? color.subtle : color.system;
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={markColor}>{mark} </Text>
        <Text color={badgeColor}>[{SOURCE_LABEL[tool.source]}] </Text>
        <Text bold>{tool.title}</Text>
        <Text dimColor>{dur}</Text>
      </Text>
      {tool.preview ? (
        <Text>
          <Text color={color.subtle}>{'  '}{glyph.tree} </Text>
          <Text dimColor>{tool.preview}</Text>
        </Text>
      ) : null}
    </Box>
  );
}

function divider(label: string): string {
  const clean = label.replace(/[─ ]/g, '').toLowerCase();
  const text = clean ? ` ${clean} ` : ' ';
  const bar = '─'.repeat(Math.max(2, 18 - text.length));
  return `─${text}${bar}`;
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}
