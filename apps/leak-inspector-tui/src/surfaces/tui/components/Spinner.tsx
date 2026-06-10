import { useEffect, useState } from 'react';
import { Text } from 'ink';
import { color, glyph, SPINNER_FRAMES } from '../theme';

export function Spinner({
  label,
  startedAt,
  tokens,
}: {
  label: string;
  startedAt?: number;
  tokens: number;
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

  const elapsed = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
  const meta = [`${elapsed}s`, tokens > 0 ? `${formatNum(tokens)} tokens` : '', 'esc to interrupt']
    .filter(Boolean)
    .join(` ${glyph.bullet} `);

  return (
    <Text>
      <Text color={color.accent}>{SPINNER_FRAMES[frame]} </Text>
      <Text color={color.accent}>{label}</Text>
      <Text dimColor>… ({meta})</Text>
    </Text>
  );
}

function formatNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
