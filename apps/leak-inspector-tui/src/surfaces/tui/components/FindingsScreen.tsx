/**
 * Full-screen findings/verdict browser (the 'findings' view) — replaces the old
 * `/report` Select-picker + log-dump. Two tabs:
 *   table  — sortable/filterable candidate list (`FindingsTable`)
 *   detail — the structured `VerdictCard` for one finding, steppable prev/next
 * Owns the keyboard while view === 'findings'. Renders identically for a live
 * post-scan bundle set and a historical snapshot (both arrive as `FindingView[]`).
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

export function FindingsScreen({ store, state, resultsDir }: { store: TuiStore; state: UiState; resultsDir: string }) {
  const fs = state.findings;
  const visible = visibleFindings(state);
  const tableRows = Math.max(5, (process.stdout.rows ?? 30) - 12);

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

  return (
    <Box flexDirection="column">
      {/* header */}
      <Text color={color.accent} bold>
        {glyph.star} FINDINGS {fs.scanId}
      </Text>
      <Text dimColor>
        {fs.source} {glyph.bullet} {fs.findings.length} findings {glyph.bullet}{' '}
        <Text color={color.error}>{counts.confirmed} confirmed</Text> {glyph.bullet}{' '}
        <Text color={color.warning}>{counts.likely} likely</Text> {glyph.bullet} sort {fs.sort}
        {fs.filter.verdict ? <Text> {glyph.bullet} verdict={fs.filter.verdict}</Text> : null}
        {fs.filter.coverage ? <Text> {glyph.bullet} cover={fs.filter.coverage}</Text> : null}
        {filtered ? <Text> {glyph.bullet} {visible.length} shown</Text> : null}
      </Text>

      <Box flexDirection="column" marginTop={1}>
        {fs.tab === 'table' ? (
          <FindingsTable findings={visible} cursor={fs.cursor} viewportRows={tableRows} />
        ) : selected ? (
          <Box flexDirection="column">
            <Text dimColor>
              finding {fs.cursor + 1} of {visible.length} {glyph.bullet} report {join(resultsDir, fs.scanId, 'report.html')}
            </Text>
            <Box marginTop={1}>
              <VerdictCard f={selected} width={Math.min(110, (process.stdout.columns ?? 100) - 2)} />
            </Box>
          </Box>
        ) : (
          <Text dimColor>(no finding selected)</Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {fs.tab === 'table' ? (
            <>
              ↑/↓ move {glyph.bullet} Enter detail {glyph.bullet} s sort {glyph.bullet} f verdict {glyph.bullet} c coverage{' '}
              {glyph.bullet} Esc exit
            </>
          ) : (
            <>
              ↑/↓ prev/next finding {glyph.bullet} ←/Esc back to table
            </>
          )}
        </Text>
      </Box>
    </Box>
  );
}
