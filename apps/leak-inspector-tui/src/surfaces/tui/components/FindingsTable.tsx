/**
 * Stateless findings table — one row per candidate, columns:
 *   severity-dot · function@line · verdict · confidence% · coverage · judge · correlation · file
 * Windowed scroll (mirrors EvalScreen's `Cases`): only `viewportRows` rows render, the
 * window centres on the cursor. Purely presentational — the parent screen owns sorting,
 * filtering, and cursor state and passes the already-visible `findings` slice in.
 */
import { Box, Text } from 'ink';
import { color } from '../theme';
import type { FindingView } from '../findings/findingView';
import { verdictStyle, coverageBadge, judgeChip, bestCorrelation } from '../findings/verdictStyle';

const basename = (p: string) => p.split('/').pop() || p;
/** Truncate-with-ellipsis then pad to a fixed column width (keeps columns aligned). */
const cell = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s.padEnd(w));
const confCell = (c: number) => `${Math.round(c * 100)}%`.padStart(4);

const COLS = { fn: 22, verdict: 20, cover: 7, judge: 9, corr: 8 } as const;

function row(f: FindingView, selected: boolean) {
  const vs = verdictStyle(f.verdict);
  const cov = coverageBadge(f.dynamicCoverage);
  const jc = judgeChip(f.verdictTool);
  const corr = bestCorrelation(f.evidence);
  return (
    <Text key={f.id} wrap="truncate-end">
      <Text color={selected ? color.accent : color.subtle}>{selected ? '❯ ' : '  '}</Text>
      <Text color={vs.color}>● </Text>
      <Text color={selected ? undefined : color.subtle} bold={selected}>{cell(`${f.function}@${f.line}`, COLS.fn)} </Text>
      <Text color={vs.color}>{cell(f.verdict, COLS.verdict)} </Text>
      <Text color={color.subtle}>{confCell(f.confidence)} </Text>
      <Text color={cov.color}>{cell(cov.label, COLS.cover)} </Text>
      <Text color={jc.color}>{cell(jc.label, COLS.judge)} </Text>
      <Text color={corr ? corr.color : color.subtle}>{cell(corr?.label ?? '', COLS.corr)} </Text>
      <Text color={color.subtle}>{basename(f.file)}</Text>
    </Text>
  );
}

export function FindingsTable({
  findings,
  cursor,
  viewportRows,
}: {
  findings: FindingView[];
  cursor: number;
  viewportRows: number;
}) {
  const n = findings.length;
  const rows = Math.max(3, viewportRows);
  const start = Math.max(0, Math.min(Math.max(0, n - rows), cursor - Math.floor(rows / 2)));
  const win = findings.slice(start, start + rows);
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {'    '}
        {cell('function@line', COLS.fn)} {cell('verdict', COLS.verdict)} conf {cell('cover', COLS.cover)} {cell('judge', COLS.judge)} {cell('corr', COLS.corr)} file
      </Text>
      {n === 0 ? (
        <Text dimColor>{'  '}(no findings match the current filter)</Text>
      ) : (
        win.map((f, i) => row(f, start + i === cursor))
      )}
      {n > rows ? (
        <Text dimColor>
          {'  '}showing {start + 1}–{Math.min(n, start + rows)} of {n}
        </Text>
      ) : null}
    </Box>
  );
}
