import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { color, glyph } from '../theme';
import { keyToIntent, reduce } from '../lineEdit';

/**
 * Prompt input with terminal-grade line editing. Replaces `ink-text-input` so we
 * can support the readline keybindings (Ctrl+A/E/U/K/W, Option+⌫, Option+←/→) that
 * the minimal upstream component ignores. The value is controlled by App; the
 * cursor offset is local. Keys map to edits via the pure `lineEdit` core; `↑/↓`,
 * `Tab`, `Enter`, `Esc` and `Ctrl+C` return `null` from `keyToIntent` so App's
 * handlers (history, suggestions, permission mode, submit, abort) still see them.
 */
export function PromptInput({
  rev,
  disabled,
  running,
  paused,
  mode,
  value,
  onChange,
  onSubmit,
}: {
  /** Bump to force the cursor back to the end (e.g. after completing a command). */
  rev: number;
  disabled: boolean;
  running: boolean;
  paused: boolean;
  mode: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  const accent = paused ? color.warning : running ? color.warning : mode === 'llm_assisted' ? color.accent : color.system;
  const border = disabled ? color.subtle : accent;
  const placeholder = paused
    ? 'type "continue" or new guidance to resume · esc to stop'
    : running
      ? 'type to steer the agent · esc to interrupt · /quit'
      : 'type / for commands, or a message';

  const [cursor, setCursor] = useState(value.length);
  // The value we last emitted ourselves — lets us tell our own edits apart from
  // an external value change (history recall / command completion), which should
  // snap the cursor to the end.
  const lastEmitted = useRef(value);

  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      setCursor(value.length);
    }
  }, [value]);

  // Explicit "reset cursor to end" trigger from App (command completion).
  useEffect(() => {
    lastEmitted.current = value;
    setCursor(value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit(value);
        return;
      }
      const intent = keyToIntent(input, key);
      if (!intent) return;
      const next = reduce({ value, cursor }, intent);
      lastEmitted.current = next.value; // mark as our own edit so the effect won't reset the cursor
      setCursor(next.cursor);
      if (next.value !== value) onChange(next.value);
    },
    { isActive: !disabled },
  );

  return (
    <Box borderStyle="round" borderColor={border} paddingX={1}>
      <Text color={disabled ? color.subtle : accent}>{glyph.pointer} </Text>
      {disabled ? <Text dimColor>awaiting permission… (y / n)</Text> : renderValue(value, cursor, placeholder)}
    </Box>
  );
}

/** Render the buffer with an inverse-video cursor block; show the placeholder when empty. */
function renderValue(value: string, cursor: number, placeholder: string) {
  if (value.length === 0) {
    return (
      <Text>
        <Text inverse>{placeholder[0] ?? ' '}</Text>
        <Text dimColor>{placeholder.slice(1)}</Text>
      </Text>
    );
  }
  const before = value.slice(0, cursor);
  const at = value[cursor] ?? ' ';
  const after = value.slice(cursor + 1);
  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
}
