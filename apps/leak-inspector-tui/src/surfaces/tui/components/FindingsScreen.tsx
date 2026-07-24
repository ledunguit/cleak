/**
 * Full-screen findings/verdict browser (the 'findings' view) — thin wrapper
 * that composes FindingsToolbar + FindingsTable/FindingsDetail based on tab
 * state. Owns the keyboard while view === 'findings'.
 *
 * Layout:
 *   ┌─ toolbar ──────────────────────────────────────────┐
 *   │  ✻ FINDINGS <scanId>                               │
 *   │  live · 12 findings · 2 confirmed · 3 likely · …   │
 *   │  Table | Detail                                     │
 *   ├─ content ───────────────────────────────────────────┤
 *   │  (FindingsTable or FindingsDetail)                  │
 *   ├─ footer ────────────────────────────────────────────┤
 *   │  ↑/↓ move · ↵ detail · s sort · esc exit            │
 *   └─────────────────────────────────────────────────────┘
 */
import { Box, Text, useInput } from 'ink';
import { join } from 'node:path';
import { color, glyph } from '../theme';
import { FindingsTable } from './FindingsTable';
import { FindingsDetail } from './FindingsDetail';
import { FindingsToolbar, Hint } from './FindingsToolbar';
import { visibleFindings, type TuiStore, type UiState } from '../../../stores';
import type { FindingView } from '../findings/findingView';

function verdictCounts(findings: FindingView[]) {
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

  return (
    <Box flexDirection="column">
      {/* ── toolbar ── */}
      <FindingsToolbar
        scanId={fs.scanId}
        source={fs.source}
        findingsTotal={fs.findings.length}
        visibleCount={visible.length}
        confirmed={counts.confirmed}
        likely={counts.likely}
        sort={fs.sort}
        filter={fs.filter}
        tab={fs.tab}
        filtered={filtered}
      />

      {/* ── content ── */}
      <Box flexDirection="column" marginTop={1}>
        {fs.tab === 'table' ? (
          <FindingsTable findings={visible} cursor={fs.cursor} viewportRows={tableRows} />
        ) : selected ? (
          <FindingsDetail
            finding={selected}
            cursor={fs.cursor}
            total={visible.length}
            reportPath={join(resultsDir, fs.scanId, 'report.html')}
          />
        ) : (
          <Text dimColor>(no finding selected)</Text>
        )}
      </Box>

      {/* ── footer key hints ── */}
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
