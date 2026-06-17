/**
 * Full-screen findings/verdict browser (the 'findings' view) — replaces the old
 * `/report` Select-picker + log-dump. Two tabs:
 *   table  — sortable/filterable candidate list (`FindingsTable`)
 *   detail — the structured `VerdictCard` for one finding, steppable prev/next
 * Owns the keyboard while view === 'findings'. Renders identically for a live
 * post-scan bundle set and a historical snapshot (both arrive as `FindingView[]`).
 * Visual language matches the rest of the TUI: a star-marked header, a chip-strip
 * summary, an EvalScreen-style tab bar, and color-coded key hints.
 */
import { Box, Text, useInput } from 'ink';
import { join } from 'node:path';
import { color, glyph } from '../theme';
import { FindingsTable } from './FindingsTable';
import { VerdictCard } from './VerdictCard';
import { visibleFindings, type TuiStore, type UiState, type FindingsUiState } from '../store';

function verdictCounts(findings: FindingsUiState['findings']) {
  let confirmed = 0;
  let likely = 0;
  for (const f of findings) {
    if (f.verdict === 'confirmed_leak') confirmed++;
    else if (f.verdict === 'likely_leak') likely++;
  }
  return { confirmed, likely };
}

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
function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <Text>
      <Text color={color.accent}>{keys}</Text>
      <Text dimColor> {label}</Text>
    </Text>
  );
}

function TabBar({ tab }: { tab: FindingsUiState['tab'] }) {
  const tabs: Array<[FindingsUiState['tab'], string]> = [
    ['table', 'Table'],
    ['detail', 'Detail'],
  ];
  return (
    <Text>
      {tabs.map(([key, label], i) => (
        <Text key={key}>
          {i > 0 ? <Text dimColor> | </Text> : null}
          <Text color={key === tab ? color.accent : color.subtle} bold={key === tab} underline={key === tab}>
            {label}
          </Text>
        </Text>
      ))}
    </Text>
  );
}

export function FindingsScreen({ store, state, resultsDir }: { store: TuiStore; state: UiState; resultsDir: string }) {
  const fs = state.findings;
  const visible = visibleFindings(state);
  const tableRows = Math.max(5, (process.stdout.rows ?? 30) - 13);

  useInput((input, key) => {
    if (!fs) return;
    if (key.escape) {
      if (fs.tab === 'detail') return store.findingsBackToTable();
      return store.findingsExit();
    }
    if (fs.tab === 'table') {
      if (key.upArrow) return store.findingsMove(-1);
      if (key.downArrow) return store.findingsMove(1);
      if (key.return || key.rightArrow) return store.findingsOpenDetail();
      if (input === 's') return store.findingsCycleSort(1);
      if (input === 'f') return store.findingsCycleFilter('verdict', 1);
      if (input === 'c') return store.findingsCycleFilter('coverage', 1);
    } else {
      if (key.leftArrow) return store.findingsBackToTable();
      if (key.upArrow) return store.findingsDetailStep(-1);
      if (key.downArrow) return store.findingsDetailStep(1);
    }
  });

  if (!fs) return null;
  const counts = verdictCounts(fs.findings);
  const selected = visible[fs.cursor];
  const filtered = visible.length !== fs.findings.length;

  const summary: Array<{ text: string; color?: string }> = [
    { text: fs.source },
    { text: `${fs.findings.length} findings` },
    { text: `${counts.confirmed} confirmed`, color: color.error },
    { text: `${counts.likely} likely`, color: color.warning },
    { text: `sort ${fs.sort}` },
  ];
  if (fs.filter.verdict) summary.push({ text: `verdict=${fs.filter.verdict}`, color: color.accent });
  if (fs.filter.coverage) summary.push({ text: `cover=${fs.filter.coverage}`, color: color.accent });
  if (filtered) summary.push({ text: `${visible.length} shown`, color: color.accent });

  return (
    <Box flexDirection="column">
      {/* header */}
      <Text>
        <Text color={color.accent} bold>
          {glyph.star} FINDINGS{' '}
        </Text>
        <Text color={color.subtle}>{fs.scanId}</Text>
      </Text>
      <Chips items={summary} />
      <Box marginTop={1}>
        <TabBar tab={fs.tab} />
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {fs.tab === 'table' ? (
          <FindingsTable findings={visible} cursor={fs.cursor} viewportRows={tableRows} />
        ) : selected ? (
          <Box flexDirection="column">
            <Text dimColor>
              finding {fs.cursor + 1} of {visible.length} {glyph.bullet} {join(resultsDir, fs.scanId, 'report.html')}
            </Text>
            <Box marginTop={1}>
              <VerdictCard f={selected} width={Math.min(110, (process.stdout.columns ?? 100) - 2)} />
            </Box>
          </Box>
        ) : (
          <Text dimColor>(no finding selected)</Text>
        )}
      </Box>

      {/* footer key hints */}
      <Box marginTop={1}>
        {fs.tab === 'table' ? (
          <Text>
            <Hint keys="↑/↓" label="move" />
            <Text color={color.subtle}> {glyph.bullet} </Text>
            <Hint keys="↵" label="detail" />
            <Text color={color.subtle}> {glyph.bullet} </Text>
            <Hint keys="s" label="sort" />
            <Text color={color.subtle}> {glyph.bullet} </Text>
            <Hint keys="f" label="verdict" />
            <Text color={color.subtle}> {glyph.bullet} </Text>
            <Hint keys="c" label="coverage" />
            <Text color={color.subtle}> {glyph.bullet} </Text>
            <Hint keys="esc" label="exit" />
          </Text>
        ) : (
          <Text>
            <Hint keys="↑/↓" label="prev/next finding" />
            <Text color={color.subtle}> {glyph.bullet} </Text>
            <Hint keys="←/esc" label="back to table" />
          </Text>
        )}
      </Box>
    </Box>
  );
}
