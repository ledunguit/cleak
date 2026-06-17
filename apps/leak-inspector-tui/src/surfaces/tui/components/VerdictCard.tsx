/**
 * Structured verdict detail for ONE finding — replaces the old `showFindingDetail`
 * log-dump with a bordered card. Every section is omitted when its data is absent
 * (older snapshots / heuristic-only verdicts), so the card degrades gracefully:
 *   header (verdict + confidence) → badges (coverage · judge · consensus agreement
 *   + samples sparkline + overridden) → why/fix → root cause → runtime evidence
 *   (tool · bytes · LINKED|file-only · allocSite) → static analysis (ownership,
 *   alloc→free pairs, feasible-leak-path narratives) → repair diff (red/green).
 */
import { Box, Text } from 'ink';
import { color, glyph } from '../theme';
import type { FindingView } from '../findings/findingView';
import { verdictStyle, coverageBadge, judgeChip, correlationLabel, samplesSparkline } from '../findings/verdictStyle';

const basename = (p: string) => p.split('/').pop() || p;
const pctOf = (n: number) => `${Math.round(n * 100)}%`;

const MAX_EVIDENCE = 6;
const MAX_PATHS = 3;
const MAX_PAIRS = 5;
const MAX_DIFF = 40;
const NARRATIVE_CAP = 280;

export function VerdictCard({ f, width }: { f: FindingView; width?: number }) {
  const vs = verdictStyle(f.verdict);
  const cov = coverageBadge(f.dynamicCoverage);
  const jc = judgeChip(f.verdictTool);
  const cons = f.consensus;
  const se = f.staticEvidence;
  const diff = f.repairDiff;
  const hasDiff = !!diff && (diff.originalLines.length > 0 || diff.suggestedLines.length > 0);

  return (
    <Box alignSelf="flex-start" flexDirection="column" borderStyle="round" borderColor={vs.color} paddingX={1} width={width}>
      {/* header */}
      <Text>
        <Text>{vs.icon} </Text>
        <Text bold color={vs.color}>
          {f.function}@{f.line}
        </Text>
        <Text color={color.subtle}> {glyph.bullet} </Text>
        <Text color={vs.color}>{f.verdict}</Text>
        <Text color={color.subtle}> {glyph.bullet} {pctOf(f.confidence)} conf</Text>
      </Text>
      {f.allocationType ? (
        <Text color={color.subtle}>
          alloc: {f.allocationType} at {basename(f.file)}:{f.line}
        </Text>
      ) : null}

      {/* badges: coverage · judge · consensus */}
      <Text>
        <Text color={cov.color}>[{cov.label}]</Text>
        <Text> </Text>
        <Text color={jc.color}>[{jc.label}]</Text>
        {cons ? (
          <>
            <Text color={color.subtle}> {glyph.bullet} agree </Text>
            <Text color={cons.agreement >= 0.6 ? color.success : color.warning}>{pctOf(cons.agreement)}</Text>
            {cons.samples.length ? <Text color={color.subtle}> {samplesSparkline(cons.samples, f.verdict)}</Text> : null}
            {cons.overridden ? <Text color={color.warning}> {glyph.bullet} overridden</Text> : null}
            {cons.fusion ? (
              <Text color={color.subtle}> {glyph.bullet} static:{cons.fusion.static}/dyn:{cons.fusion.dynamic}</Text>
            ) : null}
          </>
        ) : null}
      </Text>

      {/* explanation + repair suggestion */}
      {f.explanation ? (
        <Box marginTop={1}>
          <Text>
            <Text color={color.subtle}>why: </Text>
            {f.explanation}
          </Text>
        </Box>
      ) : null}
      {f.repairSuggestion ? <Text color={color.success}>fix: {f.repairSuggestion}</Text> : null}

      {/* root cause */}
      {f.rootCause?.patternType || f.rootCause?.description ? (
        <Text color={color.subtle}>
          root cause: {f.rootCause?.patternType ?? 'unknown'}
          {f.rootCause?.description ? ` — ${f.rootCause.description}` : ''}
          {f.rootCause?.missingFreeFunction || f.rootCause?.missingFreeLine
            ? ` (missing free near ${f.rootCause?.missingFreeFunction ?? '?'}@${f.rootCause?.missingFreeLine ?? '?'})`
            : ''}
        </Text>
      ) : null}

      {/* runtime evidence */}
      {f.evidence.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={color.system}>Runtime evidence</Text>
          {f.evidence.slice(0, MAX_EVIDENCE).map((e, i) => {
            const corr = correlationLabel(e.correlationMethod);
            return (
              <Text key={i}>
                {'  '}
                <Text color={color.system}>{e.tool}</Text>
                <Text color={color.subtle}>
                  {' '}
                  {glyph.bullet} {e.bytesLost} bytes
                </Text>
                {e.leakKind ? <Text color={color.subtle}> {glyph.bullet} {e.leakKind}</Text> : null}
                <Text color={corr.color}>
                  {' '}
                  {glyph.bullet} {corr.label}
                </Text>
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
          <Text color={color.system}>Static analysis</Text>
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
            <Text key={i} color={p.leakRisk === 'high' ? color.error : color.warning}>
              {'  '}
              {glyph.bullet} {p.narrative.slice(0, NARRATIVE_CAP)}
              {p.reachable === false ? <Text color={color.subtle}> (unreachable)</Text> : null}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* repair diff */}
      {hasDiff ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={color.subtle}>
            fix diff ({basename(diff!.filePath ?? f.file)}:{diff!.startLine ?? f.line}):
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
