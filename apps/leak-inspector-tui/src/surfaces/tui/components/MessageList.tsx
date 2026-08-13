import { Box, Text } from 'ink';
import { memo } from 'react';
import { useStore } from 'zustand';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { useViewportRows } from '../hooks/useViewportRows';
import ThemedText from '../theme/ThemedText';
import { color, glyph } from '../theme';
import type { ToolCardData, UiMessage } from '../../../stores';
import type { TuiStore } from '../../../stores';
import { windowMessages, MAX_TOOL_OUTPUT_LINES } from './messageLines';

const THINKING_PREVIEW = 80;

/**
 * A scrollable viewport over the (already agent-filtered) message log.
 * `scrollOffset` counts LINES up from the live bottom (0 = pinned).
 * `focusMsgId` highlights the line under the focus cursor (used to
 * expand/collapse thinking & tool output).
 *
 * The window is computed in terminal LINES (windowMessages) so multi-line
 * messages — expanded tool output, long replies — never get clipped by a
 * message-count slice. Viewport rows come from the shared useViewportRows.
 */
export const MessageList = memo(function MessageList({
  messages,
  scrollOffset = 0,
  focusMsgId,
}: {
  messages: UiMessage[];
  scrollOffset?: number;
  focusMsgId?: string;
}) {
  const { columns: termCols } = useTerminalSize();
  const rows = useViewportRows(4);
  const { visible, above, below } = windowMessages(messages, scrollOffset, rows, termCols);

  return (
    <Box flexDirection="column">
      {above > 0 ? (
        <ThemedText dimColor>
          {glyph.bullet} {above} more line{above === 1 ? '' : 's'} above {glyph.bullet} PageUp/PageDown to scroll
        </ThemedText>
      ) : null}
      {visible.map((m) => (
        <Box key={m.id}>
          <MessageRow message={m} focused={m.id === focusMsgId} />
        </Box>
      ))}
      {below > 0 ? (
        <ThemedText color="warning">
          {glyph.arrowDown} {below} more line{below === 1 ? '' : 's'} below {glyph.bullet} PageDown / End for live
        </ThemedText>
      ) : null}
    </Box>
  );
});

/**
 * Connected wrapper that subscribes to individual store slices via `useStoreSelector`.
 * Only re-renders when `messages`, `scrollOffset`, or `focusMsgId` change — the parent
 * can skip the full-state `useStore(store)` call if it switches to this.
 *
 * @example
 * ```tsx
 * <MessageListConnected store={store} viewportRows={viewportRows} />
 * ```
 */
export const MessageListConnected = memo(function MessageListConnected({
  store,
}: {
  store: TuiStore;
}) {
  const allMessages = useStore(store, (s) => s.messages);
  const viewAgentId = useStore(store, (s) => s.viewAgentId);
  const scrollOffset = useStore(store, (s) => s.scrollOffset);
  const focusMsgId = useStore(store, (s) => s.focusMsgId);
  const messages = viewAgentId
    ? allMessages.filter((m: UiMessage) => m.agentId === viewAgentId)
    : allMessages;

  return (
    <MessageList
      messages={messages}
      scrollOffset={scrollOffset}
      focusMsgId={focusMsgId}
    />
  );
});

/** Leading marker: a pointer when focused, else padding — keeps columns aligned. */
function focusMark(focused: boolean) {
  return focused ? <Text color={color.accent}>{glyph.pointer} </Text> : <Text>{'  '}</Text>;
}

function chevron(collapsed: boolean | undefined, focused: boolean) {
  const ch = collapsed === false ? glyph.expanded : glyph.collapsed;
  return <Text color={focused ? color.accent : color.subtle}> {ch}</Text>;
}

const ACTIVITY_ICONS: Record<string, string> = {
  calling_mcp: '►',
  reading_file: '✎',
  thinking: '◎',
  planning: '⚑',
  done: '✓',
};

function MessageRow({ message, focused }: { message: UiMessage; focused: boolean }) {
  switch (message.kind) {
    case 'user':
      return (
        <Text>
          <Text color={color.subtle}>{glyph.pointer} </Text>
          <Text>{message.text}</Text>
        </Text>
      );
    case 'thinking': {
      const collapsed = message.collapsed !== false;
      const full = message.text ?? '';
      return (
        <Box flexDirection="column">
          <Text color={focused ? color.accent : color.subtle}>
            {focused ? glyph.pointer : ' '} ◎ {collapsed ? truncate(full, THINKING_PREVIEW) : ''}
            {chevron(collapsed, focused)}
          </Text>
          {!collapsed ? <Text color={color.subtle}>{'     '}{full.trim()}</Text> : null}
        </Box>
      );
    }
    case 'assistant':
      return (
        <Text>
          {focusMark(focused)}
          <Text color={color.accent}>{glyph.mark} </Text>
          <Text>{message.text}</Text>
        </Text>
      );
    case 'system':
      return message.color ? <Text color={message.color}>{message.text}</Text> : <Text dimColor>{message.text}</Text>;
    case 'phase':
      return <Text color={color.subtle}>{divider(message.text ?? '')}</Text>;
    case 'tool':
      return message.tool ? <ToolCard tool={message.tool} collapsed={message.collapsed !== false} focused={focused} /> : null;
    case 'agent_activity': {
      const icon = ACTIVITY_ICONS[message.activityType ?? ''] ?? '*';
      return (
        <Text color={color.subtle}>
          {'  '}{icon} {message.text}
        </Text>
      );
    }
    default:
      return null;
  }
}

const SOURCE_LABEL: Record<ToolCardData['source'], string> = {
  'mcp-static': 'mcp·static',
  'mcp-dynamic': 'mcp·dynamic',
  local: 'local',
};

function ToolCard({ tool, collapsed, focused }: { tool: ToolCardData; collapsed: boolean; focused: boolean }) {
  const markColor =
    tool.status === 'running' ? color.warning : tool.status === 'error' ? color.error : color.success;
  const mark = tool.status === 'running' ? glyph.running : tool.status === 'error' ? glyph.cross : glyph.mark;
  const dur = tool.durationMs != null ? ` ${glyph.bullet} ${formatMs(tool.durationMs)}` : '';
  const badgeColor = tool.source === 'local' ? color.subtle : color.system;
  const hasMore = !!tool.output && (tool.output.length > (tool.preview?.length ?? 0));
  // Expanded output is capped by LINES (in addition to the store's char cap) so
  // a huge JSON result can't blow up the viewport height.
  const output = tool.output ?? '';
  const outLines = output.split('\n');
  const clippedLines = outLines.length > MAX_TOOL_OUTPUT_LINES;
  const shownOutput = clippedLines ? outLines.slice(0, MAX_TOOL_OUTPUT_LINES).join('\n') : output;
  return (
    <Box flexDirection="column">
      <Text>
        {focused ? <Text color={color.accent}>{glyph.pointer}</Text> : <Text> </Text>}
        <Text color={markColor}>{mark} </Text>
        <Text color={badgeColor}>[{SOURCE_LABEL[tool.source]}] </Text>
        <Text bold color={focused ? color.accent : undefined}>{tool.title}</Text>
        <Text dimColor>{dur}</Text>
        {tool.output ? chevron(collapsed, focused) : null}
      </Text>
      {collapsed ? (
        tool.preview ? (
          <Text>
            <Text color={color.subtle}>{'  '}{glyph.tree} </Text>
            <Text dimColor>{tool.preview}{hasMore ? ' …' : ''}</Text>
          </Text>
        ) : null
      ) : (
        <Text>
          <Text color={color.subtle}>{'  '}{glyph.tree} </Text>
          <Text dimColor>{shownOutput}</Text>
          {clippedLines ? <Text dimColor>{` … +${outLines.length - MAX_TOOL_OUTPUT_LINES} lines`}</Text> : null}
        </Text>
      )}
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
