/**
 * The TUI's UI state facade — composes five Zustand sub-stores into a single
 * UiState snapshot so `useStore(store, selector)` works across the app.
 *
 * This class owns NO state of its own. `getState()` / `getSnapshot()` compose
 * from the sub-stores on every call, and `subscribe()` fans out to all five.
 * The config file is the single source of truth at startup; the constructor
 * seeds all sub-stores from the resolved config values.
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

/** Default UiState snapshot — used by getInitialState(). */
const DEFAULT_UI_STATE: UiState = {
  messages: [], phases: initialPhases(), status: 'idle', statusText: 'idle',
  usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
  mode: 'llm_assisted', dynamic: 'off', provider: 'local', model: '',
  view: 'main', autoShowReport: false, fullscreen: false, permissionMode: 'ask',
  ranDynamicTool: false, scrollOffset: 0, agents: [],
  viewAgentId: 'main', navMode: 'normal', navIndex: 0,
};

export class TuiStore {
  private listeners = new Set<Listener>();
  private initialState: UiState;
  /** Cached composed state — returned by getState()/getSnapshot(). Only
   *  recomposed when a sub-store notifies us (dirty flag). This prevents
   *  infinite re-render loops: Zustand's useSyncExternalStore compares
   *  snapshots with Object.is, so we must return the same reference when
   *  nothing has changed. */
  private _cached!: UiState;
  private _dirty = true;

  constructor(init: Partial<UiState> = {}) {
    // Seed the configStore with the resolved startup values from the config file.
    const cs = configStore.getState();
    cs.setPushSystem((text, color) => scanStore.getState().addSystemMessage(text, color));
    cs.setOptions({
      mode: init.mode, dynamic: init.dynamic,
      provider: init.provider, model: init.model,
      baseUrl: init.baseUrl, apiKey: init.apiKey,
    });
    if (init.autoShowReport !== undefined) cs.setAutoShowReport(init.autoShowReport);
    if (init.fullscreen !== undefined) cs.setFullscreen(init.fullscreen);
    this._dirty = true;
    this.initialState = this.composeState();
  }

  // ── State composition — the single source of truth ──────────────────────

  /** Compose UiState from all sub-stores. Returns cached reference when
   *  nothing has changed (dirty flag is cleared by subscribe callbacks). */
  private composeState(): UiState {
    if (!this._dirty) return this._cached;
    this._dirty = false;
    const c = configStore.getState();
    const s = scanStore.getState();
    const n = navigationStore.getState();
    const es = evalStore.getState();
    const fs = findingsStore.getState();
    this._cached = {
      // scan
      messages: s.messages,
      phases: s.phases,
      currentPhase: s.currentPhase,
      status: s.status,
      statusText: s.statusText,
      usage: s.usage,
      io: s.io,
      scanId: s.scanId,
      reportDir: s.reportDir,
      summary: s.summary,
      startedAt: s.startedAt,
      ranDynamicTool: s.ranDynamicTool,
      scrollOffset: s.scrollOffset,
      agents: s.agents,
      focusMsgId: s.focusMsgId,
      // config
      mode: c.mode,
      dynamic: c.dynamic,
      provider: c.provider,
      model: c.model,
      baseUrl: c.baseUrl,
      apiKey: c.apiKey,
      autoShowReport: c.autoShowReport,
      fullscreen: c.fullscreen,
      permissionMode: c.permissionMode,
      pendingPermission: c.pendingPermission,
      // navigation
      view: n.view,
      viewAgentId: n.viewAgentId,
      navMode: n.navMode,
      navIndex: n.navIndex,
      // eval (only when an eval is active)
      eval: es.corpus ? {
        corpus: es.corpus, mode: es.mode, dynamic: es.dynamic,
        total: es.total, done: es.done, concurrency: es.concurrency,
        startedAt: es.startedAt, finishedAt: es.finishedAt,
        running: es.running, cancelling: es.cancelling,
        cases: es.cases, tab: es.tab, cursor: es.cursor,
        selectedId: es.selectedId, result: es.result, outDir: es.outDir,
      } : undefined,
      // findings (only when findings are open)
      findings: fs.scanId ? {
        scanId: fs.scanId, source: fs.source, findings: fs.findings,
        cursor: fs.cursor, sort: fs.sort, filter: fs.filter,
        tab: fs.tab, detailId: fs.detailId,
      } : undefined,
    };
    return this._cached;
  }

  /** Mark dirty and notify all listeners. Called by sub-store subscriptions. */
  private invalidate(): void {
    this._dirty = true;
    this.listeners.forEach((l) => l());
  }

  // ── Zustand-compatible interface ────────────────────────────────────────

  /** Subscribe to all sub-stores; any change triggers a notification. */
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    const unsubs = [
      configStore.subscribe(() => this.invalidate()),
      scanStore.subscribe(() => this.invalidate()),
      navigationStore.subscribe(() => this.invalidate()),
      evalStore.subscribe(() => this.invalidate()),
      findingsStore.subscribe(() => this.invalidate()),
    ];
    return () => {
      this.listeners.delete(l);
      unsubs.forEach((u) => u());
    };
  };

  /** Compose current state from all sub-stores (cached). */
  getState = (): UiState => this.composeState();

  /** Initial state snapshot — required by Zustand's ReadonlyStoreApi<T>. */
  getInitialState = (): UiState => this.initialState;

  /** Alias for getState — fulfills the Zustand useStore interface. */
  getSnapshot = (): UiState => this.composeState();

  // ── Navigation (delegated to navigationStore) ──────────────────────────

  setView(view: UiState['view']): void {
    navigationStore.getState().setView(view);
  }
  enterAgentList(): void {
    navigationStore.getState().enterAgentList();
  }
  navMove(delta: number): void {
    navigationStore.getState().navMove(delta);
  }
  openFocusedAgent(): void {
    const navState = navigationStore.getState();
    const agents = scanStore.getState().agents;
    const agent = agents[navState.navIndex];
    navState.openFocusedAgent();
    const agentId = agent?.id ?? 'main';
    const messages = scanStore.getState().messages;
    const firstMsg = messages.find((m) => m.agentId === agentId);
    // Update viewAgentId and focusMsgId in the navigation store.
    // The navigationStore.openFocusedAgent sets viewAgentId='', so we patch it.
    navigationStore.setState({ viewAgentId: agentId, focusMsgId: firstMsg?.id });
  }
  backToMain(): void {
    navigationStore.getState().backToMain();
  }
  logFocusMove(delta: number, viewportRows: number): void {
    const n = navigationStore.getState();
    const agentId = n.viewAgentId;
    const messages = scanStore.getState().messages.filter((m) => m.agentId === agentId);
    const currentIdx = messages.findIndex((m) => m.id === n.focusMsgId);
    let nextIdx: number;
    if (currentIdx < 0) {
      nextIdx = delta > 0 ? 0 : Math.max(0, messages.length - 1);
    } else {
      nextIdx = Math.max(0, Math.min(messages.length - 1, currentIdx + delta));
    }
    navigationStore.setState({ focusMsgId: messages[nextIdx]?.id });
  }
  toggleFocusedCollapse(): void {
    const { focusMsgId } = navigationStore.getState();
    if (focusMsgId) {
      scanStore.getState().updateMessage(focusMsgId, (m) => ({
        ...m,
        collapsed: !m.collapsed,
      }));
    }
  }

  // ── Config (delegated to configStore) ───────────────────────────────────

  setOptions(opts: Partial<Pick<UiState, 'mode' | 'dynamic' | 'provider' | 'model' | 'baseUrl' | 'apiKey'>>): void {
    configStore.getState().setOptions(opts);
  }
  setAutoShowReport(auto: boolean): void { configStore.getState().setAutoShowReport(auto); }
  setFullscreen(fullscreen: boolean): void { configStore.getState().setFullscreen(fullscreen); }
  cyclePermissionMode(): 'ask' | 'auto' { return configStore.getState().cyclePermissionMode(); }
  requestPermission(req: { id: string; name: string; input: unknown }): Promise<'allow' | 'deny'> {
    return configStore.getState().requestPermission(req);
  }
  resolvePermission(decision: 'allow' | 'deny'): void {
    configStore.getState().resolvePermission(decision);
  }

  // ── Scan (delegated to scanStore) ───────────────────────────────────────

  push(msg: Parameters<ScanActions['push']>[0]): string { return scanStore.getState().push(msg); }
  updateMessage(id: Parameters<ScanActions['updateMessage']>[0], updater: Parameters<ScanActions['updateMessage']>[1]): void { scanStore.getState().updateMessage(id, updater); }
  scrollBy(delta: number, maxOffset: number): void { scanStore.getState().scrollBy(delta, maxOffset); }
  scrollToBottom(): void { scanStore.getState().scrollToBottom(); }
  addUserMessage(text: string): void { scanStore.getState().addUserMessage(text); }
  addSystemMessage(text: string, color?: string): void { scanStore.getState().addSystemMessage(text, color); }
  setIo(io: UiState['io']): void { scanStore.getState().setIo(io); }
  setAbortController(ac: AbortController | undefined): void { scanStore.getState().setAbortController(ac); }
  abort(): void { scanStore.getState().abort(); }
  awaitResume(): Promise<'resume' | 'abort'> { return scanStore.getState().awaitResume(); }
  resume(): void { scanStore.getState().resume(); }
  isPaused(): boolean { return scanStore.getState().isPaused(); }
  isRunning(): boolean { return scanStore.getState().isRunning(); }
  enqueueSteering(text: string): void { scanStore.getState().enqueueSteering(text); }
  drainSteering(): string[] { return scanStore.getState().drainSteering(); }
  beginRun(scanId: string, mode: UiState['mode']): void {
    scanStore.getState().beginRun(scanId);
    navigationStore.getState().resetForNewScan();
  }
  finishRun(reportDir: string, summary: UiState['summary']): void {
    const s = this.composeState();
    const scanState = scanStore.getState();
    if (s.dynamic !== 'off' && !s.ranDynamicTool && !scanState.ranDynamicTool) {
      this.addSystemMessage('⚠ dynamic was enabled but the agent ran no dynamic tools — the model judged static evidence sufficient (selective). Use /config or /dynamic → aggressive to force a run.');
    }
    scanState.finishRun(reportDir, summary);
  }
  failRun(message: string): void { scanStore.getState().failRun(message); }
  applyScanEvent(ev: ScanEvent): void { scanStore.getState().applyScanEvent(ev); }
  applyAgentEvent(ev: AgentEvent, agent?: AgentMeta): void { scanStore.getState().applyAgentEvent(ev, agent); }

  // ── Eval (delegated to evalStore + navigationStore) ─────────────────────

  beginEval(meta: Parameters<EvalActions['beginEval']>[0]): void {
    evalStore.getState().beginEval(meta);
    navigationStore.getState().setView('eval');
  }
  evalCaseStart(id: string): void { evalStore.getState().evalCaseStart(id); }
  evalCasePhase(id: string, phase: string): void { evalStore.getState().evalCasePhase(id, phase); }
  evalCaseResult(detail: Parameters<EvalActions['evalCaseResult']>[0]): void { evalStore.getState().evalCaseResult(detail); }
  endEval(result: EvalResult, outDir: string): void { evalStore.getState().endEval(result, outDir); }
  setEvalAbort(ac: AbortController | undefined): void { evalStore.getState().setEvalAbort(ac); }
  evalAbort(): void { evalStore.getState().evalAbort(); }
  evalCycleTab(dir: 1 | -1): void { evalStore.getState().evalCycleTab(dir); }
  evalSetTab(tab: Parameters<EvalActions['evalSetTab']>[0]): void { evalStore.getState().evalSetTab(tab); }
  evalMove(delta: number): void { evalStore.getState().evalMove(delta); }
  evalOpenDetail(): void { evalStore.getState().evalOpenDetail(); }
  evalExit(): void {
    evalStore.getState().evalExit();
    navigationStore.getState().setView('main');
  }

  // ── Findings (delegated to findingsStore + navigationStore) ─────────────

  openFindings(scanId: string, source: 'live' | 'snapshot', findings: FindingView[]): void {
    findingsStore.getState().openFindings(scanId, source, findings);
    navigationStore.getState().setView('findings');
  }
  findingsMove(delta: number): void { findingsStore.getState().findingsMove(delta); }
  findingsCycleSort(dir: 1 | -1 = 1): void { findingsStore.getState().findingsCycleSort(dir); }
  findingsCycleFilter(kind: 'verdict' | 'coverage', dir: 1 | -1 = 1): void { findingsStore.getState().findingsCycleFilter(kind, dir); }
  findingsOpenDetail(): void { findingsStore.getState().findingsOpenDetail(); }
  findingsDetailStep(delta: number): void { findingsStore.getState().findingsDetailStep(delta); }
  findingsBackToTable(): void { findingsStore.getState().findingsBackToTable(); }
  findingsExit(): void {
    findingsStore.getState().findingsExit();
    navigationStore.getState().setView('main');
  }
}
