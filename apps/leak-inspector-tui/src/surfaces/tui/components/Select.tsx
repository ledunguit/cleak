import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { color, glyph } from '../theme';

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  /** Optional colour override for the label (e.g. verdict colour in the report picker). */
  color?: string;
}

/**
 * Overlay single/multi-select. Arrow keys move the highlight (wrapping), space
 * toggles (multi), Enter confirms, Esc cancels, and 1–9 jump to a row. Rendered
 * in place of the prompt while active so it owns keyboard focus.
 */
export function Select({
  title,
  options,
  multi = false,
  initial,
  onSubmit,
  onCancel,
}: {
  title: string;
  options: SelectOption[];
  multi?: boolean;
  initial?: string[];
  onSubmit: (values: string[]) => void;
  onCancel: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set(initial ?? []));

  const toggle = (value: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });

  useInput((input, key) => {
    if (key.upArrow) setIndex((i) => (i - 1 + options.length) % options.length);
    else if (key.downArrow) setIndex((i) => (i + 1) % options.length);
    else if (key.escape) onCancel();
    else if (key.return) onSubmit(multi ? [...selected] : [options[index].value]);
    else if (input === ' ' && multi) toggle(options[index].value);
    else if (/^[1-9]$/.test(input)) {
      const i = Number(input) - 1;
      if (i < options.length) {
        if (multi) {
          setIndex(i);
          toggle(options[i].value);
        } else onSubmit([options[i].value]);
      }
    }
  });

  return (
    <Box alignSelf="flex-start" flexDirection="column" borderStyle="round" borderColor={color.accent} paddingX={1}>
      <Text bold color={color.accent}>
        {title}
      </Text>
      {options.map((o, i) => {
        const hot = i === index;
        const mark = multi ? (selected.has(o.value) ? '[x] ' : '[ ] ') : '';
        return (
          <Text key={o.value}>
            <Text color={hot ? color.accent : color.subtle}>{hot ? glyph.pointer : ' '} </Text>
            <Text color={multi && selected.has(o.value) ? color.success : undefined}>{mark}</Text>
            <Text bold color={o.color ?? (hot ? color.accent : undefined)}>
              {o.label}
            </Text>
            {o.description ? <Text dimColor> {glyph.bullet} {o.description}</Text> : null}
          </Text>
        );
      })}
      <Text dimColor>
        ↑/↓ move{multi ? ' · space toggle' : ''} · enter select · esc cancel
      </Text>
    </Box>
  );
}
