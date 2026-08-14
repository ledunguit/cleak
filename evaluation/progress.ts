/**
 * Plain-console per-case progress callbacks, format-matched to
 * `scripts/evaluate-corpus.ts`'s (non-exported) `makeCallbacks()` — same visual
 * output — but re-implemented as a self-contained factory (own closure state, not
 * module-level `let`s), so `runEvalRepeated`'s per-run resets are trivial and
 * there's no shared-state hazard if this is ever invoked twice in one process.
 */
import type { EvalCaseDetail } from '../apps/leak-inspector-tui/src/domain/evalHarness';

export interface ProgressCallbacks {
  onCaseStart: (id: string) => void;
  onCasePhase?: (id: string, phase: string) => void;
  onCaseResult: (detail: EvalCaseDetail) => void;
  onProgress: (done: number, total: number, id: string) => void;
}

const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`);

export function createProgressCallbacks(verbose = false): ProgressCallbacks {
  let runningTP = 0;
  let runningFP = 0;
  let runningFN = 0;
  let runningTN = 0;
  let runningDone = 0;
  let runningInputTokens = 0;
  let runningOutputTokens = 0;
  let runningMcpCalls = 0;
  let runningOk = 0;
  let runningErr = 0;
  let runningSkp = 0;
  let totalCases = 0;

  const onProgress = (_done: number, total: number, _id: string) => {
    if (totalCases === 0 && total > 0) totalCases = total;
  };

  const onCaseStart = (id: string) => {
    process.stderr.write(`  ▶ ${id} ...\n`);
  };

  const onCasePhase = verbose
    ? (id: string, phase: string) => {
        process.stderr.write(`    ${id}: ${phase}\n`);
      }
    : undefined;

  const onCaseResult = (detail: EvalCaseDetail) => {
    const r = detail.row;
    runningDone++;
    if (r.status === 'ok') {
      runningOk++;
      runningTP += r.tp;
      runningFP += r.fp;
      runningFN += r.fn;
      runningTN += r.tn;
      runningInputTokens += r.inputTokens ?? 0;
      runningOutputTokens += r.outputTokens ?? 0;
      runningMcpCalls += r.mcpCalls ?? 0;
    } else if (r.status === 'error') runningErr++;
    else runningSkp++;

    const jp = r.judgePathCounts
      ? (Object.entries(r.judgePathCounts).sort((a, b) => b[1] - a[1]).map(([k]) => k)[0] ?? '?')
      : '?';
    const fv = r.functionalVariant ? ` [${r.functionalVariant}]` : '';
    const icon = r.status === 'ok' ? '✓' : r.status === 'error' ? '✗' : '⊘';

    if (r.status === 'ok') {
      const dur = r.durationMs >= 1000 ? `${(r.durationMs / 1000).toFixed(1)}s` : `${r.durationMs}ms`;
      const tok = `in=${fmtTok(r.inputTokens ?? 0)}/out=${fmtTok(r.outputTokens ?? 0)}`;
      process.stderr.write(
        `  ${icon} ${detail.id}${fv} · TP=${r.tp} FP=${r.fp} FN=${r.fn} TN=${r.tn}` +
          ` · cand=${r.candidates} flg=${r.flagged} · ${dur} · ${r.mcpCalls ?? 0}MCP · ${tok} · ${jp}\n`,
      );
    } else {
      process.stderr.write(`  ${icon} ${detail.id}${fv} · ${r.error ?? 'skipped'}\n`);
    }

    const denom = totalCases || runningDone;
    const sumTok = `in=${fmtTok(runningInputTokens)}/out=${fmtTok(runningOutputTokens)}`;
    process.stderr.write(
      `  ─ ${runningDone}/${denom} · TP=${runningTP} FP=${runningFP} FN=${runningFN} TN=${runningTN}` +
        ` · ∑${sumTok} · ∑${runningMcpCalls}MCP · ${runningOk}ok ${runningErr}err ${runningSkp}skp\n`,
    );
  };

  return { onCaseStart, onCasePhase, onCaseResult, onProgress };
}
