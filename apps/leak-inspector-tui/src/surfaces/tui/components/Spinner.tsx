import { useEffect, useState } from 'react';
import { Text } from 'ink';
import { color, glyph, formatDuration, SPINNER_FRAMES } from '../theme';

export function Spinner({
  label,
  startedAt,
  usage,
  io,
}: {
  label: string;
  startedAt?: number;
  usage: { inputTokens: number; outputTokens: number; thinkingTokens: number };
  io?: 'up' | 'down';
}) {
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(() => startedAt ?? 0);
  useEffect(() => {
    const t = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
      setNow(Date.now());
    }, 120);
    return () => clearInterval(t);
  }, []);

  const elapsed = startedAt ? formatDuration(now - startedAt) : '0s';
  const total = usage.inputTokens + usage.outputTokens;
  const tokenStr =
    total > 0
      ? `${formatNum(usage.inputTokens)}↑ ${formatNum(usage.outputTokens)}↓` +
        (usage.thinkingTokens > 0 ? ` ${formatNum(usage.thinkingTokens)}🧠` : '') +
        ' tok'
      : '';
  const meta = [elapsed, tokenStr, 'esc to interrupt'].filter(Boolean).join(` ${glyph.bullet} `);

  // While a request is in flight, show the send (↑) / receive (↓) cue in place of
  // the spinner frame; otherwise animate the spinner.
  const lead =
    io === 'up' ? glyph.arrowUp : io === 'down' ? glyph.arrowDown : SPINNER_FRAMES[frame];

  return (
    <Text>
      <Text color={color.accent}>{lead} </Text>
      <Text color={color.accent}>{label}</Text>
      <Text dimColor>… ({meta})</Text>
    </Text>
  );
}

function formatNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
