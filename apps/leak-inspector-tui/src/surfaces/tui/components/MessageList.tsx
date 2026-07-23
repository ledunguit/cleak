import { Box, Text } from 'ink';
import { memo } from 'react';
import { color, glyph } from '../theme';
import type { ToolCardData, UiMessage } from '../store';
import { visibleMessages, type TuiStore } from '../store';
import { useStoreSelector } from '../store/selectors';

const DEFAULT_VIEWPORT = 24;
const THINKING_PREVIEW = 80;

/**
 * A scrollable viewport over the (already agent-filtered) message log. `scrollOffset`
 * counts messages up from the live bottom (0 = pinned). `focusMsgId` highlights the
 * line under the focus cursor (used to expand/collapse thinking & tool output).
 */
export const MessageList = memo(function MessageList({
  messages,
  scrollOffset = 0,
  viewportRows = DEFAULT_VIEWPORT,
  focusMsgId,
}: {
  messages: UiMessage[];
  scrollOffset?: number;
  viewportRows?: number;
  focusMsgId?: string;
}) {
  const rows = Math.max(4, viewportRows);
  const end = Math.max(0, messages.length - scrollOffset);
  const start = Math.max(0, end - rows);
  const visible = messages.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = messages.length - end;

  return (
    <Box flexDirection="column">
      {hiddenAbove > 0 ? (
        <Text color={color.subtle} dimColor>
          {glyph.bullet} {hiddenAbove} more above {glyph.bullet} PageUp/PageDown to scroll
        </Text>
      ) : null}
      {visible.map((m) => (
        <Box key={m.id}>
          <MessageRow message={m} focused={m.id === focusMsgId} />
        </Box>
      ))}
      {hiddenBelow > 0 ? (
        <Text color={color.warning} dimColor>
          {glyph.arrowDown} {hiddenBelow} below {glyph.bullet} PageDown / End for live
        </Text>
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
  viewportRows,
}: {
  store: TuiStore;
  viewportRows: number;
}) {
  const messages = useStoreSelector(store, visibleMessages);
  const scrollOffset = useStoreSelector(store, (s) => s.scrollOffset);
  const focusMsgId = useStoreSelector(store, (s) => s.focusMsgId);

  return (
    <MessageList
      messages={messages}
      scrollOffset={scrollOffset}
      viewportRows={viewportRows}
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
            {focused ? glyph.pointer : ' '} 💭 {collapsed ? truncate(full, THINKING_PREVIEW) : ''}
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
          <Text dimColor>{tool.output}</Text>
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
