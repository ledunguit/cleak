import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTerminalSize } from '../hooks/useTerminalSize';
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
 * in place of the prompt while active so it owns keyboard focus. The option
 * list is windowed to the terminal height (centered on the cursor) so a long
 * option list — e.g. /eval history — never overflows a small terminal.
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
  const { rows: termRows } = useTerminalSize();
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set(initial ?? []));

  const windowRows = Math.max(5, termRows - 12);
  const n = options.length;
  const start = Math.max(0, Math.min(Math.max(0, n - windowRows), index - Math.floor(windowRows / 2)));
  const win = options.slice(start, start + windowRows);

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
      {win.map((o, j) => {
        const i = start + j;
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
      {n > windowRows ? (
        <Text dimColor>
          showing {start + 1}–{Math.min(n, start + windowRows)} of {n} {glyph.bullet} ↑/↓ to move
        </Text>
      ) : null}
      <Text dimColor>
        ↑/↓ move{multi ? ' · space toggle' : ''} · enter select · esc cancel
      </Text>
    </Box>
  );
}
