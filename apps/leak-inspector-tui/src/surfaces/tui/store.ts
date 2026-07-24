/**
 * The TUI's UI state + a tiny observable store (no external state lib). The
 * store ingests two streams — ScanEvents (phase/timeline) and raw AgentEvents
 * (assistant text + tool cards) — into a unified message list + phase map that
 * the React/Ink components render.
 *
 * This file is now a thin facade that composes five domain sub-stores while
 * preserving the original TuiStore public API for runner.ts, evalRunner.ts,
 * App.tsx, and all component subscribers.
 */

import type { AgentEvent } from '@cleak/agent-core';
import type { ScanEvent } from '../../orchestrator/events';
import type { AgentMeta } from '../../orchestrator/investigation';
import type { EvalResult } from '../../domain/evalHarness';
import type { SnapshotFinding, LabeledFlaw, CleanSite } from '../../domain/evalScoring';
import type { FindingView } from './findings/findingView';

import { navigationStore } from '../../stores/navigation-store';
import { scanStore } from '../../stores/scan-store';
import type { ScanActions } from '../../stores/scan-store';
import { configStore } from '../../stores/config-store';
import { evalStore } from '../../stores/eval-store';
import type { EvalActions } from '../../stores/eval-store';
import { findingsStore } from '../../stores/findings-store';
import type { FindingsActions } from '../../stores/findings-store';
import { visibleFindings as _visibleFindings } from '../../stores/findings-store';

// ── Re-export all types and standalone functions for backward compatibility ──

/** Filter messages by the active agent (takes full UiState, not (messages[], viewAgentId)). */
export function visibleMessages(state: UiState): UiMessage[] {
  return state.messages.filter((m: UiMessage) => m.agentId === state.viewAgentId);
}

export function visibleFindings(state: UiState): FindingView[] {
  return _visibleFindings(state.findings);
}
export type {
  PhaseStatus, RunStatus, ToolCardData, UiMessage, AgentInfo, NavMode,
  PendingPermission, EvalCaseStatus, EvalCaseUi, EvalTab, EvalUiState,
  FindingsTab, FindingsSort, FindingsUiState, UiState,
} from '../../stores/types';

import type { NavMode, UiMessage, UiState } from '../../stores/types';
import { SCAN_PHASE_ORDER, ScanPhase } from '@cleak/common/flow/scan-flow-contract';

/** Listener signature compatible with Zustand's ReadonlyStoreApi.subscribe. */
type Listener = (state?: unknown, prevState?: unknown) => void;

function initialPhases(): Record<ScanPhase, 'pending'> {
  const p = {} as Record<ScanPhase, 'pending'>;
  for (const ph of SCAN_PHASE_ORDER) p[ph] = 'pending';
  return p;
}

export class TuiStore {
  private state: UiState;
  private _initialState: UiState;
  private listeners = new Set<Listener>();

  constructor(init: Partial<UiState> = {}) {
    this.state = {
      messages: [], phases: initialPhases(), status: 'idle', statusText: 'idle',
      usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
      mode: 'llm_assisted', dynamic: 'off', provider: 'local', model: '',
      view: 'main', autoShowReport: false, permissionMode: 'ask',
      ranDynamicTool: false, scrollOffset: 0, agents: [],
      viewAgentId: 'main', navMode: 'normal', navIndex: 0,
      ...init,
    };
    this._initialState = { ...this.state };

    // Initialize cross-store callback for configStore
    configStore.getState().setPushSystem((text, color) => scanStore.getState().addSystemMessage(text, color));
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** Alias for getSnapshot — fulfills the Zustand useStore interface. */
  getState = (): UiState => this.state;

  /** Initial state snapshot — required by Zustand's ReadonlyStoreApi<T>. */
  getInitialState = (): UiState => this._initialState;

  getSnapshot = (): UiState => this.state;

  // ── Navigation (delegated to Zustand navigationStore) ──
  setView(view: UiState['view']): void {
    navigationStore.getState().setView(view);
    this.state = { ...this.state, view };
  }
  enterAgentList(): void {
    navigationStore.getState().enterAgentList();
    this.syncNav();
  }
  navMove(delta: number): void {
    navigationStore.getState().navMove(delta);
    this.syncNav();
  }
  openFocusedAgent(): void {
    const navState = navigationStore.getState();
    const agents = scanStore.getState().agents;
    const agent = agents[navState.navIndex];
    navState.openFocusedAgent();
    const agentId = agent?.id ?? 'main';
    const messages = scanStore.getState().messages;
    const firstMsg = messages.find((m) => m.agentId === agentId);
    this.state = {
      ...this.state,
      viewAgentId: agentId,
      navMode: 'agentlog' as NavMode,
      focusMsgId: firstMsg?.id,
    };
  }
  backToMain(): void {
    navigationStore.getState().backToMain();
    this.syncNav();
  }
  logFocusMove(delta: number, viewportRows: number): void {
    const agentId = this.state.viewAgentId;
    const messages = scanStore.getState().messages.filter((m) => m.agentId === agentId);
    const currentIdx = messages.findIndex((m) => m.id === this.state.focusMsgId);
    let nextIdx: number;
    if (currentIdx < 0) {
      nextIdx = delta > 0 ? 0 : Math.max(0, messages.length - 1);
    } else {
      nextIdx = Math.max(0, Math.min(messages.length - 1, currentIdx + delta));
    }
    this.state = { ...this.state, focusMsgId: messages[nextIdx]?.id };
  }
  toggleFocusedCollapse(): void {
    const { focusMsgId } = this.state;
    if (focusMsgId) {
      scanStore.getState().updateMessage(focusMsgId, (m) => ({
        ...m,
        collapsed: !m.collapsed,
      }));
      this.syncScan();
    }
  }

  // ── Config (delegated to Zustand configStore) ──
  setOptions(opts: Partial<Pick<UiState, 'mode' | 'dynamic' | 'provider' | 'model' | 'baseUrl' | 'apiKey'>>): void {
    configStore.getState().setOptions(opts); this.syncConfig();
  }
  setAutoShowReport(auto: boolean): void { configStore.getState().setAutoShowReport(auto); this.syncConfig(); }
  cyclePermissionMode(): 'ask' | 'auto' { const r = configStore.getState().cyclePermissionMode(); this.syncConfig(); return r; }
  requestPermission(req: { id: string; name: string; input: unknown }): Promise<'allow' | 'deny'> {
    const result = configStore.getState().requestPermission(req);
    this.syncConfig();
    return result;
  }
  resolvePermission(decision: 'allow' | 'deny'): void {
    configStore.getState().resolvePermission(decision);
    this.syncConfig();
  }

  // ── Sync helpers — pull Zustand state back into this.state for getSnapshot() callers ──
  private syncConfig(): void {
    const c = configStore.getState();
    this.state = { ...this.state, mode: c.mode, dynamic: c.dynamic, provider: c.provider, model: c.model, baseUrl: c.baseUrl, apiKey: c.apiKey, autoShowReport: c.autoShowReport, permissionMode: c.permissionMode, pendingPermission: c.pendingPermission };
  }
  private syncScan(): void {
    const s = scanStore.getState();
    this.state = { ...this.state, messages: s.messages, phases: s.phases, currentPhase: s.currentPhase, status: s.status, statusText: s.statusText, usage: s.usage, io: s.io, scanId: s.scanId, reportDir: s.reportDir, summary: s.summary, startedAt: s.startedAt, ranDynamicTool: s.ranDynamicTool, scrollOffset: s.scrollOffset, agents: s.agents, focusMsgId: s.focusMsgId };
  }
  private syncNav(): void {
    const n = navigationStore.getState();
    this.state = { ...this.state, view: n.view, navMode: n.navMode, navIndex: n.navIndex, viewAgentId: n.viewAgentId, focusMsgId: n.focusMsgId };
  }

  // ── Scan (delegated to Zustand scanStore) ──
  push(msg: Parameters<ScanActions['push']>[0]): string { const r = scanStore.getState().push(msg); this.syncScan(); return r; }
  updateMessage(id: Parameters<ScanActions['updateMessage']>[0], updater: Parameters<ScanActions['updateMessage']>[1]): void { scanStore.getState().updateMessage(id, updater); this.syncScan(); }
  scrollBy(delta: number, maxOffset: number): void { scanStore.getState().scrollBy(delta, maxOffset); this.syncScan(); }
  scrollToBottom(): void { scanStore.getState().scrollToBottom(); this.syncScan(); }
  addUserMessage(text: string): void { scanStore.getState().addUserMessage(text); this.syncScan(); }
  addSystemMessage(text: string, color?: string): void { scanStore.getState().addSystemMessage(text, color); this.syncScan(); }
  setIo(io: UiState['io']): void { scanStore.getState().setIo(io); this.syncScan(); }
  setAbortController(ac: AbortController | undefined): void { scanStore.getState().setAbortController(ac); }
  abort(): void { scanStore.getState().abort(); this.syncScan(); }
  awaitResume(): Promise<'resume' | 'abort'> { return scanStore.getState().awaitResume(); }
  resume(): void { scanStore.getState().resume(); this.syncScan(); }
  isPaused(): boolean { return scanStore.getState().isPaused(); }
  isRunning(): boolean { return scanStore.getState().isRunning(); }
  enqueueSteering(text: string): void { scanStore.getState().enqueueSteering(text); }
  drainSteering(): string[] { return scanStore.getState().drainSteering(); }
  beginRun(scanId: string, mode: UiState['mode']): void {
    scanStore.getState().beginRun(scanId);
    navigationStore.getState().resetForNewScan();
    this.syncScan();
  }
  finishRun(reportDir: string, summary: UiState['summary']): void {
    const scanState = scanStore.getState();
    if (this.state.dynamic !== 'off' && !this.state.ranDynamicTool && !scanState.ranDynamicTool) {
      this.addSystemMessage('⚠ dynamic was enabled but the agent ran no dynamic tools — the model judged static evidence sufficient (selective). Use /config or /dynamic → aggressive to force a run.');
    }
    scanState.finishRun(reportDir, summary);
    this.syncScan();
  }
  failRun(message: string): void { scanStore.getState().failRun(message); this.syncScan(); }
  applyScanEvent(ev: ScanEvent): void { scanStore.getState().applyScanEvent(ev); this.syncScan(); }
  applyAgentEvent(ev: AgentEvent, agent?: AgentMeta): void { scanStore.getState().applyAgentEvent(ev, agent); this.syncScan(); }

  // ── Sync helpers ──
  private syncFindings(): void {
    const fs = findingsStore.getState();
    this.state = {
      ...this.state,
      findings: {
        scanId: fs.scanId, source: fs.source, findings: fs.findings,
        cursor: fs.cursor, sort: fs.sort, filter: fs.filter,
        tab: fs.tab, detailId: fs.detailId,
      },
    };
  }
  private syncEval(): void {
    const es = evalStore.getState();
    this.state = {
      ...this.state,
      eval: {
        corpus: es.corpus, mode: es.mode, dynamic: es.dynamic,
        total: es.total, done: es.done, concurrency: es.concurrency,
        startedAt: es.startedAt, finishedAt: es.finishedAt,
        running: es.running, cancelling: es.cancelling,
        cases: es.cases, tab: es.tab, cursor: es.cursor,
        selectedId: es.selectedId, result: es.result, outDir: es.outDir,
      },
    };
  }

  // ── Eval (delegated to Zustand evalStore, then sync) ──
  beginEval(meta: Parameters<EvalActions['beginEval']>[0]): void {
    evalStore.getState().beginEval(meta);
    this.syncEval();
    this.state = { ...this.state, view: 'eval' };
  }
  evalCaseStart(id: string): void { evalStore.getState().evalCaseStart(id); this.syncEval(); }
  evalCasePhase(id: string, phase: string): void { evalStore.getState().evalCasePhase(id, phase); this.syncEval(); }
  evalCaseResult(detail: Parameters<EvalActions['evalCaseResult']>[0]): void { evalStore.getState().evalCaseResult(detail); this.syncEval(); }
  endEval(result: EvalResult, outDir: string): void { evalStore.getState().endEval(result, outDir); this.syncEval(); }
  setEvalAbort(ac: AbortController | undefined): void { evalStore.getState().setEvalAbort(ac); }
  evalAbort(): void { evalStore.getState().evalAbort(); this.syncEval(); }
  evalCycleTab(dir: 1 | -1): void { evalStore.getState().evalCycleTab(dir); this.syncEval(); }
  evalSetTab(tab: Parameters<EvalActions['evalSetTab']>[0]): void { evalStore.getState().evalSetTab(tab); this.syncEval(); }
  evalMove(delta: number): void { evalStore.getState().evalMove(delta); this.syncEval(); }
  evalOpenDetail(): void { evalStore.getState().evalOpenDetail(); this.syncEval(); }
  evalExit(): void {
    evalStore.getState().evalExit();
    this.state = { ...this.state, view: 'main' };
  }

  // ── Findings (delegated to Zustand findingsStore, then sync) ──
  openFindings(scanId: string, source: 'live' | 'snapshot', findings: FindingView[]): void {
    findingsStore.getState().openFindings(scanId, source, findings);
    this.syncFindings();
    this.state = { ...this.state, view: 'findings' };
  }
  findingsMove(delta: number): void { findingsStore.getState().findingsMove(delta); this.syncFindings(); }
  findingsCycleSort(dir: 1 | -1 = 1): void { findingsStore.getState().findingsCycleSort(dir); this.syncFindings(); }
  findingsCycleFilter(kind: 'verdict' | 'coverage', dir: 1 | -1 = 1): void { findingsStore.getState().findingsCycleFilter(kind, dir); this.syncFindings(); }
  findingsOpenDetail(): void { findingsStore.getState().findingsOpenDetail(); this.syncFindings(); }
  findingsDetailStep(delta: number): void { findingsStore.getState().findingsDetailStep(delta); this.syncFindings(); }
  findingsBackToTable(): void { findingsStore.getState().findingsBackToTable(); this.syncFindings(); }
  findingsExit(): void {
    findingsStore.getState().findingsExit();
    this.state = { ...this.state, view: 'main' };
  }
}
