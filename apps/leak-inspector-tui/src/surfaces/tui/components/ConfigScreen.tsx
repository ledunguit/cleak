import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { color, glyph } from '../theme';
import type { UserPreferences } from '../preferences';

interface FieldDef {
  key: keyof UserPreferences;
  label: string;
  options: Array<{ value: string | boolean; label: string }>;
}

const FIELDS: FieldDef[] = [
  {
    key: 'defaultMode',
    label: 'Default analysis mode',
    options: [
      { value: 'llm_assisted', label: 'llm_assisted' },
      { value: 'no_llm', label: 'no_llm' },
    ],
  },
  {
    key: 'defaultDynamic',
    label: 'Default dynamic analysis',
    options: [
      { value: 'off', label: 'off' },
      { value: 'selective', label: 'selective' },
      { value: 'aggressive', label: 'aggressive' },
    ],
  },
  {
    key: 'autoShowReport',
    label: 'Auto-show report when a scan finishes',
    options: [
      { value: false, label: 'off' },
      { value: true, label: 'on' },
    ],
  },
];

/** A dedicated settings screen. Owns its keys while the 'config' view is active. */
export function ConfigScreen({
  initial,
  onSave,
  onCancel,
}: {
  initial: UserPreferences;
  onSave: (prefs: UserPreferences) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<UserPreferences>({ ...initial });
  const [row, setRow] = useState(0);

  const cycle = (dir: 1 | -1) => {
    const field = FIELDS[row];
    const opts = field.options;
    const cur = opts.findIndex((o) => o.value === (draft as any)[field.key]);
    const next = opts[(cur + dir + opts.length) % opts.length];
    setDraft({ ...draft, [field.key]: next.value });
  };

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (input === 's') return onSave(draft);
    if (key.upArrow) setRow((r) => (r - 1 + FIELDS.length) % FIELDS.length);
    else if (key.downArrow) setRow((r) => (r + 1) % FIELDS.length);
    else if (key.leftArrow) cycle(-1);
    else if (key.rightArrow || key.return) cycle(1);
  });

  return (
    <Box flexDirection="column">
      <Text color={color.accent} bold>
        {glyph.star} Settings
      </Text>
      <Text dimColor>
        {glyph.arrowUp}/{glyph.arrowDown} row {glyph.bullet} ←/→ or Enter to change {glyph.bullet} s to save {glyph.bullet} Esc to cancel
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {FIELDS.map((f, i) => {
          const value = (draft as any)[f.key];
          const valueLabel = f.options.find((o) => o.value === value)?.label ?? String(value);
          const selected = i === row;
          return (
            <Text key={String(f.key)}>
              <Text color={selected ? color.accent : color.subtle}>{selected ? glyph.pointer : ' '} </Text>
              <Text color={selected ? undefined : color.subtle}>{f.label.padEnd(40)}</Text>
              <Text color={selected ? color.accent : color.system} bold={selected}>
                {' '}
                {valueLabel}
              </Text>
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Saved to ~/.config/leak-inspector/prefs.json {glyph.bullet} applies to new scans this session
        </Text>
      </Box>
    </Box>
  );
}
