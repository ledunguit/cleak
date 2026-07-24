/**
 * Findings sub-store (Zustand) — interactive findings/verdict browser state: open,
 * sort, filter, cursor, detail stepper, and the memoised visibleFindings() derivation.
 *
 * Migration note: converted from surfaces/tui/store/findings-store.ts class.
 * Has NO cross-store dependencies — manages only FindingsUiState.
 * View switching (e.g. findings→main) is handled by FindingsScreen UI code.
 */

import { createStore } from 'zustand/vanilla';
import { verdictSeverityRank } from '../surfaces/tui/findings/findingView';
import type { FindingView } from '../surfaces/tui/findings/findingView';
import type { FindingsUiState, FindingsSort } from './types';

// ── Memoised visible-findings ──
// Cache the expensive sort+filter result; invalidate only when the inputs
// (findings reference, sort key, filter values) actually change.

let _vfFindings: FindingView[] | undefined;
let _vfSort: string | undefined;
let _vfFVerdict: string | undefined;
let _vfFCoverage: string | undefined;
let _vfResult: FindingView[] = [];

export function visibleFindings(fs: FindingsUiState | undefined): FindingView[] {
  if (!fs) return [];
  const fVerdict = fs.filter.verdict ?? '';
  const fCoverage = fs.filter.coverage ?? '';
  if (
    _vfFindings === fs.findings &&
    _vfSort === fs.sort &&
    _vfFVerdict === fVerdict &&
    _vfFCoverage === fCoverage
  ) {
    return _vfResult;
  }
  let list = fs.findings;
  if (fs.filter.verdict) list = list.filter((x) => x.verdict === fs.filter.verdict);
  if (fs.filter.coverage) list = list.filter((x) => x.dynamicCoverage === fs.filter.coverage);
  const sorted = [...list];
  if (fs.sort === 'severity')
    sorted.sort((a, b) => verdictSeverityRank(b.verdict) - verdictSeverityRank(a.verdict) || b.confidence - a.confidence);
  else if (fs.sort === 'confidence') sorted.sort((a, b) => b.confidence - a.confidence);
  else if (fs.sort === 'file') sorted.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  _vfFindings = fs.findings;
  _vfSort = fs.sort;
  _vfFVerdict = fVerdict;
  _vfFCoverage = fCoverage;
  _vfResult = sorted;
  return sorted;
}

// ─── State & Actions interfaces ──────────────────────────────────────────────

export interface FindingsActions {
  openFindings: (scanId: string, source: 'live' | 'snapshot', findings: FindingView[]) => void;
  findingsMove: (delta: number) => void;
  findingsCycleSort: (dir?: 1 | -1) => void;
  findingsCycleFilter: (kind: 'verdict' | 'coverage', dir?: 1 | -1) => void;
  findingsOpenDetail: () => void;
  findingsDetailStep: (delta: number) => void;
  findingsBackToTable: () => void;
  findingsExit: () => void;
}

export type FindingsState = FindingsUiState;
export type FindingsStore = typeof findingsStore;

// ─── Store creation ──────────────────────────────────────────────────────────

export const findingsStore = createStore<FindingsState & FindingsActions>()((set, get) => {
  /**
   * Apply a slice change that may reorder/shrink the visible list (sort/filter),
   * keeping the cursor on the SAME finding when it survives — else clamp to range.
   */
  function repointCursor(next: FindingsUiState): FindingsUiState {
    const s = get();
    const prevId = visibleFindings(s)[s.cursor]?.id;
    const nextVisible = visibleFindings(next);
    let cursor = prevId ? nextVisible.findIndex((f) => f.id === prevId) : 0;
    if (cursor < 0) cursor = 0;
    cursor = Math.max(0, Math.min(Math.max(0, nextVisible.length - 1), cursor));
    return { ...next, cursor };
  }

  return {
    // ─── Initial state ────────────────────────────────────────────────
    scanId: '',
    source: 'live' as const,
    findings: [],
    cursor: 0,
    sort: 'severity' as FindingsSort,
    filter: {},
    tab: 'table' as const,

    // ─── Actions ──────────────────────────────────────────────────────

    openFindings: (scanId, source, findings) =>
      set({
        scanId,
        source,
        findings,
        cursor: 0,
        sort: 'severity',
        filter: {},
        tab: 'table',
      }),

    findingsMove: (delta) => {
      const s = get();
      const n = visibleFindings(s).length;
      if (n === 0) return;
      set({ cursor: Math.max(0, Math.min(n - 1, s.cursor + delta)) });
    },

    findingsCycleSort: (dir = 1) => {
      const s = get();
      const order: FindingsSort[] = ['severity', 'confidence', 'file'];
      const i = order.indexOf(s.sort);
      const nextSort = order[(i + dir + order.length) % order.length];
      const next: FindingsUiState = { ...s, sort: nextSort };
      set(repointCursor(next));
    },

    findingsCycleFilter: (kind, dir = 1) => {
      const s = get();
      const present =
        kind === 'verdict'
          ? s.findings.map((f) => f.verdict)
          : s.findings.map((f) => f.dynamicCoverage);
      const values: (string | undefined)[] = [undefined, ...Array.from(new Set(present))];
      const cur = kind === 'verdict' ? s.filter.verdict : s.filter.coverage;
      const idx = Math.max(0, values.findIndex((v) => v === cur));
      const nextVal = values[(idx + dir + values.length) % values.length];
      const filter = { ...s.filter, [kind]: nextVal };
      set(repointCursor({ ...s, filter }));
    },

    findingsOpenDetail: () => {
      const s = get();
      const f = visibleFindings(s)[s.cursor];
      if (f) set({ detailId: f.id, tab: 'detail' });
    },

    findingsDetailStep: (delta) => {
      const s = get();
      const visible = visibleFindings(s);
      if (visible.length === 0) return;
      const cursor = Math.max(0, Math.min(visible.length - 1, s.cursor + delta));
      set({ cursor, detailId: visible[cursor]?.id });
    },

    findingsBackToTable: () => {
      set({ tab: 'table' });
    },

    /** Reset findings state — the view switch (e.g. to 'main') is handled
     *  by FindingsScreen / navigationStore. */
    findingsExit: () => {
      set({
        scanId: '',
        source: 'live',
        findings: [],
        cursor: 0,
        sort: 'severity',
        filter: {},
        tab: 'table',
        detailId: undefined,
      });
    },
  };
});
