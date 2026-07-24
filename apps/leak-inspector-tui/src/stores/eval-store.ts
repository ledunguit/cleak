/**
 * Eval sub-store (Zustand) — benchmark evaluation dashboard state (cases, tabs,
 * cursor, abort controller). Drives the EVAL screen rendered by EvalScreen.tsx.
 *
 * This is a PURE store: it manages ONLY EvalUiState. The view switch on evalExit
 * ('main') is handled by the component / EvalScreen calling navigationStore.
 *
 * Migration note: converted from surfaces/tui/store/eval-store.ts class.
 */

import { createStore } from 'zustand/vanilla';
import type { EvalUiState, EvalCaseUi, EvalTab } from './types';
import type { EvalResult } from '../domain/evalHarness';
import type { SnapshotFinding, LabeledFlaw, CleanSite } from '../domain/evalScoring';

// ─── State & Actions interfaces ───────────────────────────────────────────

export interface EvalState extends EvalUiState {}

export interface EvalActions {
  beginEval: (meta: {
    corpus: string; mode: string; dynamic: string; total: number; concurrency: number;
    cases: Array<Pick<EvalCaseUi, 'id' | 'cwe' | 'flowVariant' | 'functionalVariant'>>;
  }) => void;
  evalCaseStart: (id: string) => void;
  evalCasePhase: (id: string, phase: string) => void;
  evalCaseResult: (detail: {
    id: string; status: 'ok' | 'error' | 'skipped';
    tp: number; fp: number; fn: number; tn: number;
    candidates?: number; flagged?: number; durationMs?: number;
    scanId?: string; error?: string;
    findings?: SnapshotFinding[]; flaws?: LabeledFlaw[]; clean?: CleanSite[];
  }) => void;
  endEval: (result: EvalResult, outDir: string) => void;
  setEvalAbort: (ac: AbortController | undefined) => void;
  evalAbort: () => void;
  evalCycleTab: (dir: 1 | -1) => void;
  evalSetTab: (tab: EvalTab) => void;
  evalMove: (delta: number) => void;
  evalOpenDetail: () => void;
  evalExit: () => void;
}

// ─── Store creation ────────────────────────────────────────────────────────

export const evalStore = createStore<EvalState & EvalActions>()((set, get) => {
  let evalAbortController: AbortController | undefined;

  return {
    // ── Initial state ──────────────────────────────────────────────────────
    corpus: '',
    mode: '',
    dynamic: '',
    total: 0,
    done: 0,
    concurrency: 1,
    startedAt: 0,
    running: false,
    cases: [],
    tab: 'cases' as EvalTab,
    cursor: 0,

    // ── Actions ────────────────────────────────────────────────────────────

    beginEval: (meta) => {
      set({
        corpus: meta.corpus,
        mode: meta.mode,
        dynamic: meta.dynamic,
        total: meta.total,
        done: 0,
        concurrency: meta.concurrency,
        startedAt: Date.now(),
        running: true,
        cases: meta.cases.map((c) => ({
          ...c,
          status: 'pending' as const,
          tp: 0,
          fp: 0,
          fn: 0,
          tn: 0,
        })),
        tab: 'cases' as EvalTab,
        cursor: 0,
      });
    },

    evalCaseStart: (id) => {
      set((s) => ({
        cases: s.cases.map((c) =>
          c.id === id ? { ...c, status: 'running' as const, startedAt: Date.now(), phase: 'starting' } : c,
        ),
      }));
    },

    evalCasePhase: (id, phase) => {
      set((s) => ({
        cases: s.cases.map((c) =>
          c.id === id && c.status === 'running' ? { ...c, phase } : c,
        ),
      }));
    },

    evalCaseResult: (detail) => {
      const { id, ...rest } = detail;
      set((s) => ({
        done: s.done + 1,
        cases: s.cases.map((c) =>
          c.id === id
            ? { ...c, ...rest, phase: undefined }
            : c,
        ),
      }));
    },

    endEval: (result, outDir) => {
      evalAbortController = undefined;
      set({ running: false, cancelling: false, finishedAt: Date.now(), result, outDir });
    },

    setEvalAbort: (ac) => {
      evalAbortController = ac;
    },

    evalAbort: () => {
      const s = get();
      if (!s.running || s.cancelling) return;
      evalAbortController?.abort();
      set({
        cancelling: true,
        cases: s.cases.map((c) =>
          c.status === 'pending' ? { ...c, status: 'skipped' as const } : c,
        ),
      });
    },

    evalCycleTab: (dir) => {
      const s = get();
      const order: EvalTab[] = ['overview', 'cases', 'detail'];
      const i = order.indexOf(s.tab);
      set({ tab: order[(i + dir + order.length) % order.length] });
    },

    evalSetTab: (tab) => set({ tab }),

    evalMove: (delta) => {
      const s = get();
      const n = s.cases.length;
      if (n === 0) return;
      set({ cursor: Math.max(0, Math.min(n - 1, s.cursor + delta)) });
    },

    evalOpenDetail: () => {
      const s = get();
      const c = s.cases[s.cursor];
      if (c) set({ selectedId: c.id, tab: 'detail' });
    },

    evalExit: () => {
      // View switch (setView('main')) handled by EvalScreen caller.
      set({ running: false, cases: [], tab: 'cases', cursor: 0 });
    },
  };
});

export type EvalStore = typeof evalStore;
