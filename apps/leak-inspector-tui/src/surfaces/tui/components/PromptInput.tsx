import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { color, glyph } from '../theme';

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
  /** Bump to remount the input (resets the cursor to the end after a completion). */
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
  return (
    <Box borderStyle="round" borderColor={border} paddingX={1}>
      <Text color={disabled ? color.subtle : accent}>{glyph.pointer} </Text>
      {disabled ? (
        <Text dimColor>awaiting permission… (y / n)</Text>
      ) : (
        <TextInput key={rev} value={value} onChange={onChange} onSubmit={onSubmit} placeholder={placeholder} />
      )}
    </Box>
  );
}
