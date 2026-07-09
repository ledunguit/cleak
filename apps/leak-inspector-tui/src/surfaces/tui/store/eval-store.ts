/**
 * Eval sub-store — benchmark evaluation dashboard state (cases, tabs, cursor,
 * abort controller). Drives the EVAL screen rendered by EvalScreen.tsx.
 */

import type { StoreAccess, EvalUiState, EvalCaseUi, EvalTab } from './types';
import type { EvalResult } from '../../../domain/evalHarness';
import type { SnapshotFinding, LabeledFlaw, CleanSite } from '../../../domain/evalScoring';

export class EvalStore {
  private evalAbortController?: AbortController;

  constructor(private access: StoreAccess) {}

  private patchEval(patch: Partial<EvalUiState>): void {
    const s = this.access.get();
    if (!s.eval) return;
    this.access.set({ eval: { ...s.eval, ...patch } });
  }

  private patchEvalCase(id: string, patch: Partial<EvalCaseUi>): void {
    const s = this.access.get();
    if (!s.eval) return;
    const cases = s.eval.cases.map((c) => (c.id === id ? { ...c, ...patch } : c));
    this.access.set({ eval: { ...s.eval, cases } });
  }

  beginEval(meta: {
    corpus: string; mode: string; dynamic: string; total: number; concurrency: number;
    cases: Array<Pick<EvalCaseUi, 'id' | 'cwe' | 'flowVariant' | 'functionalVariant'>>;
  }): void {
    this.access.set({
      view: 'eval',
      eval: {
        corpus: meta.corpus, mode: meta.mode, dynamic: meta.dynamic,
        total: meta.total, done: 0, concurrency: meta.concurrency,
        startedAt: Date.now(), running: true,
        cases: meta.cases.map((c) => ({ ...c, status: 'pending', tp: 0, fp: 0, fn: 0, tn: 0 })),
        tab: 'cases', cursor: 0,
      },
    });
  }

  evalCaseStart(id: string): void {
    this.patchEvalCase(id, { status: 'running', startedAt: Date.now(), phase: 'starting' });
  }

  evalCasePhase(id: string, phase: string): void {
    const c = this.access.get().eval?.cases.find((x) => x.id === id);
    if (c && c.status === 'running') this.patchEvalCase(id, { phase });
  }

  evalCaseResult(detail: {
    id: string; status: 'ok' | 'error' | 'skipped';
    tp: number; fp: number; fn: number; tn: number;
    candidates?: number; flagged?: number; durationMs?: number;
    scanId?: string; error?: string;
    findings?: SnapshotFinding[]; flaws?: LabeledFlaw[]; clean?: CleanSite[];
  }): void {
    const s = this.access.get();
    if (!s.eval) return;
    const { id, ...rest } = detail;
    this.patchEvalCase(id, { ...rest, phase: undefined });
    this.patchEval({ done: s.eval.done + 1 });
  }

  endEval(result: EvalResult, outDir: string): void {
    this.evalAbortController = undefined;
    this.patchEval({ running: false, cancelling: false, finishedAt: Date.now(), result, outDir });
  }

  setEvalAbort(ac: AbortController | undefined): void {
    this.evalAbortController = ac;
  }

  evalAbort(): void {
    const s = this.access.get();
    if (!s.eval || !s.eval.running || s.eval.cancelling) return;
    this.evalAbortController?.abort();
    const cases = s.eval.cases.map((c) =>
      c.status === 'pending' ? { ...c, status: 'skipped' as const } : c,
    );
    this.access.set({ eval: { ...s.eval, cancelling: true, cases } });
  }

  evalCycleTab(dir: 1 | -1): void {
    const s = this.access.get();
    if (!s.eval) return;
    const order: EvalTab[] = ['overview', 'cases', 'detail'];
    const i = order.indexOf(s.eval.tab);
    this.patchEval({ tab: order[(i + dir + order.length) % order.length] });
  }

  evalSetTab(tab: EvalTab): void {
    this.patchEval({ tab });
  }

  evalMove(delta: number): void {
    const s = this.access.get();
    if (!s.eval) return;
    const n = s.eval.cases.length;
    if (n === 0) return;
    this.patchEval({ cursor: Math.max(0, Math.min(n - 1, s.eval.cursor + delta)) });
  }

  evalOpenDetail(): void {
    const s = this.access.get();
    if (!s.eval) return;
    const c = s.eval.cases[s.eval.cursor];
    if (c) this.patchEval({ selectedId: c.id, tab: 'detail' });
  }

  evalExit(): void {
    this.access.set({ view: 'main' });
  }
}
