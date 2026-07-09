/**
 * Bridges a /eval request from the TUI to the benchmark harness, driving the
 * live EVAL dashboard (store.eval). Cases run in PARALLEL (concurrency pool) and
 * the aggregate is finalized ONCE at the end (runEval). Per-case start/phase/
 * result callbacks stream into the store so the Overview/Cases/Detail tabs
 * update live. Mirrors runner.ts but for batch evaluation.
 */

import { resolve, basename, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from '../../config';
import { runEval } from '../../domain/evalHarness';
import { writeEval } from '../../domain/evalReport';
import { color, glyph } from './theme';
import type { TuiStore } from './store';

export interface TuiEvalRequest {
  corpus: string;
  mode: 'no_llm' | 'llm_assisted';
  dynamic: 'off' | 'selective' | 'aggressive';
  limit?: number;
  concurrency?: number;
  resume?: boolean;
  staticUrl?: string;
  dynamicUrl?: string;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export async function runTuiEval(store: TuiStore, req: TuiEvalRequest): Promise<void> {
  const cfg = loadConfig({
    provider: store.getSnapshot().provider as any,
    ...(req.staticUrl ? { staticUrl: req.staticUrl } : {}),
    ...(req.dynamicUrl ? { dynamicUrl: req.dynamicUrl } : {}),
  });

  const corpusDir = resolve(req.corpus);
  if (!existsSync(join(corpusDir, 'corpus_manifest.json'))) {
    store.addSystemMessage(
      `no corpus_manifest.json in ${corpusDir} — run scripts/juliet/ingest.ts first`,
      color.error,
    );
    return;
  }

  // A stable out dir when resuming (so the per-case cache is found); a
  // timestamped one otherwise (so separate runs don't clobber each other).
  const base = `eval-${basename(corpusDir)}-${req.mode}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join(cfg.resultsDir, req.resume ? base : `${base}-${stamp}`);

  // Read the case list up front so the dashboard can show every case as pending.
  let allCases: Array<{ id: string; cwe?: string; flowVariant?: string; functionalVariant?: string }> = [];
  try {
    const manifest = JSON.parse(readFileSync(join(corpusDir, 'corpus_manifest.json'), 'utf-8'));
    allCases = (manifest.cases ?? []).slice(0, req.limit ?? Infinity);
  } catch {
    /* runEval will surface a parse error */
  }
  const concurrency = req.concurrency ?? (req.mode === 'no_llm' ? 6 : 3);

  store.beginEval({
    corpus: basename(corpusDir),
    mode: req.mode,
    dynamic: req.dynamic,
    total: allCases.length,
    concurrency,
    cases: allCases.map((c) => ({
      id: c.id,
      cwe: c.cwe,
      flowVariant: c.flowVariant,
      functionalVariant: c.functionalVariant,
    })),
  });

  // ESC on the dashboard trips this: in-flight cases abort, pending ones skip,
  // and the run still finalizes a report over whatever completed.
  const abort = new AbortController();
  store.setEvalAbort(abort);

  try {
    const result = await runEval({
      corpusDir,
      mode: req.mode,
      dynamic: req.dynamic,
      outDir,
      limit: req.limit,
      resume: req.resume,
      concurrency,
      signal: abort.signal,
      staticUrl: cfg.staticUrl,
      dynamicUrl: cfg.dynamicUrl,
      onCaseStart: (id) => store.evalCaseStart(id),
      onCasePhase: (id, phase) => store.evalCasePhase(id, phase),
      onCaseResult: (d) =>
        store.evalCaseResult({
          id: d.id,
          status: d.row.status === 'ok' ? 'ok' : 'error',
          tp: d.row.tp,
          fp: d.row.fp,
          fn: d.row.fn,
          tn: d.row.tn,
          candidates: d.row.candidates,
          flagged: d.row.flagged,
          durationMs: d.row.durationMs,
          scanId: d.scanId,
          error: d.row.error,
          findings: d.findings,
          flaws: d.flaws,
          clean: d.clean,
        }),
    });

    const files = writeEval(outDir, result);
    store.endEval(result, outDir);

    // Also drop a one-line summary into the main log, so it's visible even if the
    // user has exited the EVAL screen. Note partial coverage if it was cancelled.
    const m = result.overall;
    const cancelled = abort.signal.aborted;
    store.addSystemMessage(
      `eval ${basename(corpusDir)} ${cancelled ? 'cancelled' : 'done'} ${glyph.bullet} ` +
        `${result.ranOk}/${result.caseCount} scored ${glyph.bullet} P ${pct(m.precision)} ${glyph.bullet} R ${pct(m.recall)} ` +
        `${glyph.bullet} F1 ${pct(m.f1)} ${glyph.bullet} TP${m.tp} FP${m.fp} FN${m.fn} TN${m.tn} ${glyph.bullet} ${outDir}`,
      cancelled ? color.warning : color.success,
    );
    store.addSystemMessage(`  artifacts: ${files.map((f) => basename(f)).join(', ')}`, color.system);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.addSystemMessage(`eval failed: ${msg}`, color.error);
  } finally {
    store.setEvalAbort(undefined);
  }
}
