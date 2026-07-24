/**
 * Findings header toolbar — scan metadata summary + Table/Detail tab bar.
 * Extracted from the old monolithic FindingsScreen. Stateless: the parent
 * owns all cursor/tab/filter state and passes the rendered values in.
 *
 * Layout (from top): FINDINGS title row, chip-strip summary (confirmed /
 * likely / sort / active filters), and a two-tab bar (Table | Detail).
 *
 * Also exports the `Hint` helper so the parent can render context-sensitive
 * footer key hints that share the same accent/dim idiom.
 */
import { Box, Text } from 'ink';
import { color, glyph } from '../theme';
import type { FindingsTab } from '../../../stores';

// ── Inline helpers ────────────────────────────────────────────────────────

/** A row of chips joined by ` · ` (the Footer idiom). */
function Chips({ items }: { items: Array<{ text: string; color?: string }> }) {
  return (
    <Text>
      {items.map((c, i) => (
        <Text key={i}>
          {i > 0 ? <Text color={color.subtle}> {glyph.bullet} </Text> : null}
          <Text color={c.color ?? color.subtle}>{c.text}</Text>
        </Text>
      ))}
    </Text>
  );
}

/** A `key label` hint with the key in accent (the Welcome idiom). */
function TabBar({ tab }: { tab: FindingsTab }) {
  const tabs: Array<[FindingsTab, string]> = [
    ['table', 'Table'],
    ['detail', 'Detail'],
  ];
  return (
    <Text>
      {tabs.map(([key, label], i) => (
        <Text key={key}>
          {i > 0 ? <Text dimColor> | </Text> : null}
          <Text
            color={key === tab ? color.accent : color.subtle}
            bold={key === tab}
            underline={key === tab}
          >
            {label}
          </Text>
        </Text>
      ))}
    </Text>
  );
}

// ── Public API ────────────────────────────────────────────────────────────

/** A `key label` hint — shared so FindingsScreen can render the footer. */
export function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <Text>
      <Text color={color.accent}>{keys}</Text>
      <Text dimColor> {label}</Text>
    </Text>
  );
}

export interface FindingsToolbarProps {
  scanId: string;
  source: string;
  findingsTotal: number;
  visibleCount: number;
  confirmed: number;
  likely: number;
  sort: string;
  filter: { verdict?: string; coverage?: string };
  tab: FindingsTab;
  filtered: boolean;
}

export function FindingsToolbar({
  scanId,
  source,
  findingsTotal,
  visibleCount,
  confirmed,
  likely,
  sort,
  filter,
  tab,
  filtered,
}: FindingsToolbarProps) {
  const summary: Array<{ text: string; color?: string }> = [
    { text: source },
    { text: `${findingsTotal} findings` },
    { text: `${confirmed} confirmed`, color: color.error },
    { text: `${likely} likely`, color: color.warning },
    { text: `sort ${sort}` },
  ];
  if (filter.verdict) summary.push({ text: `verdict=${filter.verdict}`, color: color.accent });
  if (filter.coverage) summary.push({ text: `cover=${filter.coverage}`, color: color.accent });
  if (filtered) summary.push({ text: `${visibleCount} shown`, color: color.accent });

  return (
    <Box flexDirection="column">
      {/* ── title ── */}
      <Text>
        <Text color={color.accent} bold>
          {glyph.star} FINDINGS{' '}
        </Text>
        <Text color={color.subtle}>{scanId}</Text>
      </Text>

      {/* ── summary chips ── */}
      <Chips items={summary} />

      {/* ── tab bar ── */}
      <Box marginTop={1}>
        <TabBar tab={tab} />
      </Box>
    </Box>
  );
}
