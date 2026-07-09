/**
 * Findings sub-store — interactive findings/verdict browser state: open, sort,
 * filter, cursor, detail stepper, and the memoised visibleFindings() derivation.
 */

import { verdictSeverityRank } from '../findings/findingView';
import type { FindingView } from '../findings/findingView';
import type { StoreAccess, UiState, FindingsUiState, FindingsSort } from './types';

// ── Memoised visible-findings ──
// Cache the expensive sort+filter result; invalidate only when the inputs
// (findings reference, sort key, filter values) actually change.

let _vfFindings: FindingView[] | undefined;
let _vfSort: string | undefined;
let _vfFVerdict: string | undefined;
let _vfFCoverage: string | undefined;
let _vfResult: FindingView[] = [];

export function visibleFindings(state: UiState): FindingView[] {
  const f = state.findings;
  if (!f) return [];
  const fVerdict = f.filter.verdict ?? '';
  const fCoverage = f.filter.coverage ?? '';
  if (
    _vfFindings === f.findings &&
    _vfSort === f.sort &&
    _vfFVerdict === fVerdict &&
    _vfFCoverage === fCoverage
  ) {
    return _vfResult;
  }
  let list = f.findings;
  if (f.filter.verdict) list = list.filter((x) => x.verdict === f.filter.verdict);
  if (f.filter.coverage) list = list.filter((x) => x.dynamicCoverage === f.filter.coverage);
  const sorted = [...list];
  if (f.sort === 'severity')
    sorted.sort((a, b) => verdictSeverityRank(b.verdict) - verdictSeverityRank(a.verdict) || b.confidence - a.confidence);
  else if (f.sort === 'confidence') sorted.sort((a, b) => b.confidence - a.confidence);
  else if (f.sort === 'file') sorted.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  _vfFindings = f.findings;
  _vfSort = f.sort;
  _vfFVerdict = fVerdict;
  _vfFCoverage = fCoverage;
  _vfResult = sorted;
  return sorted;
}

export class FindingsStore {
  constructor(private access: StoreAccess) {}

  private patchFindings(patch: Partial<FindingsUiState>): void {
    const s = this.access.get();
    if (!s.findings) return;
    this.access.set({ findings: { ...s.findings, ...patch } });
  }

  /**
   * Apply a slice change that may reorder/shrink the visible list (sort/filter),
   * keeping the cursor on the SAME finding when it survives — else clamp to range.
   */
  private repointCursor(next: FindingsUiState): FindingsUiState {
    const s = this.access.get();
    const prevId = visibleFindings(s)[s.findings?.cursor ?? 0]?.id;
    const nextVisible = visibleFindings({ ...s, findings: next } as UiState);
    let cursor = prevId ? nextVisible.findIndex((f) => f.id === prevId) : 0;
    if (cursor < 0) cursor = 0;
    cursor = Math.max(0, Math.min(Math.max(0, nextVisible.length - 1), cursor));
    return { ...next, cursor };
  }

  openFindings(scanId: string, source: 'live' | 'snapshot', findings: FindingView[]): void {
    this.access.set({
      view: 'findings',
      findings: { scanId, source, findings, cursor: 0, sort: 'severity', filter: {}, tab: 'table' },
    });
  }

  findingsMove(delta: number): void {
    const s = this.access.get();
    if (!s.findings) return;
    const n = visibleFindings(s).length;
    if (n === 0) return;
    this.patchFindings({ cursor: Math.max(0, Math.min(n - 1, s.findings.cursor + delta)) });
  }

  findingsCycleSort(dir: 1 | -1 = 1): void {
    const s = this.access.get();
    if (!s.findings) return;
    const order: FindingsSort[] = ['severity', 'confidence', 'file'];
    const i = order.indexOf(s.findings.sort);
    const sort = order[(i + dir + order.length) % order.length];
    this.access.set({ findings: this.repointCursor({ ...s.findings, sort }) });
  }

  findingsCycleFilter(kind: 'verdict' | 'coverage', dir: 1 | -1 = 1): void {
    const s = this.access.get();
    if (!s.findings) return;
    const fs = s.findings;
    const present = kind === 'verdict' ? fs.findings.map((f) => f.verdict) : fs.findings.map((f) => f.dynamicCoverage);
    const values: (string | undefined)[] = [undefined, ...Array.from(new Set(present))];
    const cur = kind === 'verdict' ? fs.filter.verdict : fs.filter.coverage;
    const idx = Math.max(0, values.findIndex((v) => v === cur));
    const nextVal = values[(idx + dir + values.length) % values.length];
    const filter = { ...fs.filter, [kind]: nextVal };
    this.access.set({ findings: this.repointCursor({ ...fs, filter }) });
  }

  findingsOpenDetail(): void {
    const s = this.access.get();
    if (!s.findings) return;
    const f = visibleFindings(s)[s.findings.cursor];
    if (f) this.patchFindings({ detailId: f.id, tab: 'detail' });
  }

  findingsDetailStep(delta: number): void {
    const s = this.access.get();
    if (!s.findings) return;
    const visible = visibleFindings(s);
    if (visible.length === 0) return;
    const cursor = Math.max(0, Math.min(visible.length - 1, s.findings.cursor + delta));
    this.patchFindings({ cursor, detailId: visible[cursor]?.id });
  }

  findingsBackToTable(): void {
    this.patchFindings({ tab: 'table' });
  }

  findingsExit(): void {
    this.access.set({ view: 'main' });
  }
}
