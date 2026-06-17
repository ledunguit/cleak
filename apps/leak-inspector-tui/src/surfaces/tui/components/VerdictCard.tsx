/**
 * Structured verdict detail for ONE finding — a bordered card in the verdict's
 * severity color. Design: a header zone (title · meta · confidence-meter + badge
 * strip) is split from the body by a dim rule; body sections carry violet
 * uppercase labels and are omitted when empty, so the card degrades gracefully
 * (older snapshots / heuristic-only verdicts) and stays sparse.
 */
import { Box, Text } from 'ink';
import { color, glyph } from '../theme';
import type { FindingView } from '../findings/findingView';
import {
  verdictStyle,
  coverageBadge,
  judgeChip,
  correlationLabel,
  samplesSparkline,
  confidenceMeter,
} from '../findings/verdictStyle';

const basename = (p: string) => p.split('/').pop() || p;
const pctOf = (n: number) => `${Math.round(n * 100)}%`;

const MAX_EVIDENCE = 6;
const MAX_PATHS = 3;
const MAX_PAIRS = 5;
const MAX_DIFF = 40;
const NARRATIVE_CAP = 280;

/** ` · ` divider in the secondary color — the codebase-wide chip separator. */
const Dot = () => <Text color={color.subtle}> {glyph.bullet} </Text>;
/** Violet uppercase section label — type-as-hierarchy, no boxes. */
const Label = ({ children }: { children: string }) => <Text color={color.system}>{children}</Text>;

export function VerdictCard({ f, width }: { f: FindingView; width?: number }) {
  const vs = verdictStyle(f.verdict);
  const cov = coverageBadge(f.dynamicCoverage);
  const jc = judgeChip(f.verdictTool);
  const cons = f.consensus;
  const se = f.staticEvidence;
  const diff = f.repairDiff;
  const hasDiff = !!diff && (diff.originalLines.length > 0 || diff.suggestedLines.length > 0);
  const inner = Math.max(24, (width ?? (process.stdout.columns ?? 100) - 2) - 4);
  const rule = '─'.repeat(inner);
  const evTool = Math.min(8, Math.max(4, ...f.evidence.map((e) => e.tool.length), 4));

  return (
    <Box alignSelf="flex-start" flexDirection="column" borderStyle="round" borderColor={vs.color} paddingX={1} width={width}>
      {/* ── header zone ── */}
      <Text>
        <Text>{vs.icon} </Text>
        <Text bold color={vs.color}>
          {f.function}@{f.line}
        </Text>
      </Text>
      <Text color={color.subtle}>
        {f.verdict}
        {f.allocationType ? ` ${glyph.bullet} ${f.allocationType} at ${basename(f.file)}:${f.line}` : ''}
      </Text>
      <Text>
        <Text color={vs.color}>{confidenceMeter(f.confidence)}</Text>
        <Text color={color.subtle}> {pctOf(f.confidence)}</Text>
        <Dot />
        <Text color={cov.color}>{cov.label}</Text>
        <Dot />
        <Text color={jc.color}>{jc.label}</Text>
        {cons ? (
          <>
            <Dot />
            <Text color={color.subtle}>agree </Text>
            <Text color={cons.agreement >= 0.6 ? color.success : color.warning}>{pctOf(cons.agreement)}</Text>
            {cons.samples.length ? <Text color={color.subtle}> {samplesSparkline(cons.samples, f.verdict)}</Text> : null}
            {cons.overridden ? (
              <>
                <Dot />
                <Text color={color.warning}>overridden</Text>
              </>
            ) : null}
            {cons.fusion ? (
              <>
                <Dot />
                <Text color={color.subtle}>
                  S:{cons.fusion.static}/D:{cons.fusion.dynamic}
                </Text>
              </>
            ) : null}
          </>
        ) : null}
      </Text>
      <Text color={color.subtle}>{rule}</Text>

      {/* ── body ── */}
      {f.explanation ? (
        <Text>
          <Label>why </Label>
          {f.explanation}
        </Text>
      ) : null}
      {f.repairSuggestion ? (
        <Text>
          <Label>fix </Label>
          <Text color={color.success}>{f.repairSuggestion}</Text>
        </Text>
      ) : null}
      {f.rootCause?.patternType || f.rootCause?.description ? (
        <Text>
          <Label>cause </Label>
          <Text color={color.subtle}>
            {f.rootCause?.patternType ?? 'unknown'}
            {f.rootCause?.description ? ` — ${f.rootCause.description}` : ''}
            {f.rootCause?.missingFreeFunction || f.rootCause?.missingFreeLine
              ? ` (missing free near ${f.rootCause?.missingFreeFunction ?? '?'}@${f.rootCause?.missingFreeLine ?? '?'})`
              : ''}
          </Text>
        </Text>
      ) : null}

      {/* runtime evidence */}
      {f.evidence.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Label>RUNTIME EVIDENCE</Label>
          {f.evidence.slice(0, MAX_EVIDENCE).map((e, i) => {
            const corr = correlationLabel(e.correlationMethod);
            return (
              <Text key={i}>
                {'  '}
                <Text color={color.system}>{e.tool.padEnd(evTool)}</Text>
                <Text color={color.subtle}> {e.bytesLost} bytes</Text>
                {e.leakKind ? <Text color={color.subtle}> {glyph.bullet} {e.leakKind}</Text> : null}
                <Text color={color.subtle}> {glyph.bullet} </Text>
                <Text color={corr.color}>{corr.label}</Text>
                {e.allocSite ? (
                  <Text color={color.subtle}>
                    {' '}
                    {glyph.bullet} {basename(e.allocSite.file)}:{e.allocSite.line}
                  </Text>
                ) : null}
              </Text>
            );
          })}
          {f.evidence.length > MAX_EVIDENCE ? <Text dimColor>{'  '}… +{f.evidence.length - MAX_EVIDENCE} more</Text> : null}
        </Box>
      ) : null}

      {/* static analysis */}
      {se ? (
        <Box flexDirection="column" marginTop={1}>
          <Label>STATIC ANALYSIS</Label>
          {se.ownership ? (
            <Text color={color.subtle}>
              {'  '}ownership: {se.ownership.role}
              {se.ownership.rationale ? ` — ${se.ownership.rationale}` : ''}
            </Text>
          ) : null}
          {se.allocFreePairs.length ? (
            <Text color={color.subtle}>
              {'  '}alloc→free:{' '}
              {se.allocFreePairs
                .slice(0, MAX_PAIRS)
                .map((p) => `${p.variable}@${p.allocLine ?? '?'}${p.status === 'unpaired' ? ' (unpaired)' : `→free@${p.freeLine ?? '?'}`}`)
                .join(', ')}
            </Text>
          ) : null}
          {se.feasiblePaths.slice(0, MAX_PATHS).map((p, i) => (
            <Text key={i}>
              <Text color={p.leakRisk === 'high' ? color.error : color.warning}>{'  '}{glyph.bullet} </Text>
              <Text color={color.subtle}>
                {p.narrative.slice(0, NARRATIVE_CAP)}
                {p.reachable === false ? ' (unreachable)' : ''}
              </Text>
            </Text>
          ))}
        </Box>
      ) : null}

      {/* repair diff */}
      {hasDiff ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Label>FIX DIFF </Label>
            <Text color={color.subtle}>
              {basename(diff!.filePath ?? f.file)}:{diff!.startLine ?? f.line}
            </Text>
          </Text>
          {diff!.originalLines.slice(0, MAX_DIFF).map((l, i) => (
            <Text key={`o${i}`} color={color.error}>
              {'  '}- {l}
            </Text>
          ))}
          {diff!.suggestedLines.slice(0, MAX_DIFF).map((l, i) => (
            <Text key={`s${i}`} color={color.success}>
              {'  '}+ {l}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
