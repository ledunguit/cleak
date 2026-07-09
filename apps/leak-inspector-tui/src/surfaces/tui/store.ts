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

import { NavigationStore, visibleMessages as _visibleMessages } from './store/navigation-store';
import { ConfigStore } from './store/config-store';
import { ScanStore } from './store/scan-store';
import { EvalStore } from './store/eval-store';
import { FindingsStore, visibleFindings as _visibleFindings } from './store/findings-store';

// ── Re-export all types and standalone functions for backward compatibility ──
export { visibleMessages } from './store/navigation-store';
export { visibleFindings } from './store/findings-store';
export type {
  PhaseStatus, RunStatus, ToolCardData, UiMessage, AgentInfo, NavMode,
  PendingPermission, EvalCaseStatus, EvalCaseUi, EvalTab, EvalUiState,
  FindingsTab, FindingsSort, FindingsUiState, UiState,
} from './store/types';

import type { UiState } from './store/types';
import { SCAN_PHASE_ORDER, ScanPhase } from '@cleak/common/flow/scan-flow-contract';

type Listener = () => void;

function initialPhases(): Record<ScanPhase, 'pending'> {
  const p = {} as Record<ScanPhase, 'pending'>;
  for (const ph of SCAN_PHASE_ORDER) p[ph] = 'pending';
  return p;
}

export class TuiStore {
  private state: UiState;
  private listeners = new Set<Listener>();

  private scan: ScanStore;
  private config: ConfigStore;
  private nav: NavigationStore;
  private eval_: EvalStore;
  private findings: FindingsStore;

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

    const access = {
      get: () => this.state,
      set: (patch: Partial<UiState>) => {
        this.state = { ...this.state, ...patch };
        for (const l of this.listeners) l();
      },
    };

    this.scan = new ScanStore(access);
    this.nav = new NavigationStore(access);
    this.eval_ = new EvalStore(access);
    this.findings = new FindingsStore(access);
    this.config = new ConfigStore(access, (text, color) => this.scan.addSystemMessage(text, color));
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): UiState => this.state;

  // ── Navigation ──
  setView(view: UiState['view']): void { this.nav.setView(view); }
  enterAgentList(): void { this.nav.enterAgentList(); }
  navMove(delta: number): void { this.nav.navMove(delta); }
  openFocusedAgent(): void { this.nav.openFocusedAgent(); }
  backToMain(): void { this.nav.backToMain(); }
  logFocusMove(delta: number, viewportRows: number): void { this.nav.logFocusMove(delta, viewportRows); }
  toggleFocusedCollapse(): void { this.nav.toggleFocusedCollapse(); }

  // ── Config ──
  setOptions(opts: Parameters<ConfigStore['setOptions']>[0]): void { this.config.setOptions(opts); }
  setAutoShowReport(auto: boolean): void { this.config.setAutoShowReport(auto); }
  cyclePermissionMode(): 'ask' | 'auto' { return this.config.cyclePermissionMode(); }
  requestPermission(req: Parameters<ConfigStore['requestPermission']>[0]): ReturnType<ConfigStore['requestPermission']> {
    return this.config.requestPermission(req);
  }
  resolvePermission(decision: 'allow' | 'deny'): void { this.config.resolvePermission(decision); }

  // ── Scan ──
  push(msg: Parameters<ScanStore['push']>[0]): string { return this.scan.push(msg); }
  updateMessage(id: string, updater: Parameters<ScanStore['updateMessage']>[1]): void { this.scan.updateMessage(id, updater); }
  scrollBy(delta: number, maxOffset: number): void { this.scan.scrollBy(delta, maxOffset); }
  scrollToBottom(): void { this.scan.scrollToBottom(); }
  addUserMessage(text: string): void { this.scan.addUserMessage(text); }
  addSystemMessage(text: string, color?: string): void { this.scan.addSystemMessage(text, color); }
  setIo(io: UiState['io']): void { this.scan.setIo(io); }
  setAbortController(ac: AbortController | undefined): void { this.scan.setAbortController(ac); }
  abort(): void { this.scan.abort(); }
  awaitResume(): Promise<'resume' | 'abort'> { return this.scan.awaitResume(); }
  resume(): void { this.scan.resume(); }
  isPaused(): boolean { return this.scan.isPaused(); }
  isRunning(): boolean { return this.scan.isRunning(); }
  enqueueSteering(text: string): void { this.scan.enqueueSteering(text); }
  drainSteering(): string[] { return this.scan.drainSteering(); }
  beginRun(scanId: string, mode: UiState['mode']): void { this.scan.beginRun(scanId, mode); }
  finishRun(reportDir: string, summary: UiState['summary']): void { this.scan.finishRun(reportDir, summary); }
  failRun(message: string): void { this.scan.failRun(message); }
  applyScanEvent(ev: ScanEvent): void { this.scan.applyScanEvent(ev); }
  applyAgentEvent(ev: AgentEvent, agent?: AgentMeta): void { this.scan.applyAgentEvent(ev, agent); }

  // ── Eval ──
  beginEval(meta: Parameters<EvalStore['beginEval']>[0]): void { this.eval_.beginEval(meta); }
  evalCaseStart(id: string): void { this.eval_.evalCaseStart(id); }
  evalCasePhase(id: string, phase: string): void { this.eval_.evalCasePhase(id, phase); }
  evalCaseResult(detail: Parameters<EvalStore['evalCaseResult']>[0]): void { this.eval_.evalCaseResult(detail); }
  endEval(result: EvalResult, outDir: string): void { this.eval_.endEval(result, outDir); }
  setEvalAbort(ac: AbortController | undefined): void { this.eval_.setEvalAbort(ac); }
  evalAbort(): void { this.eval_.evalAbort(); }
  evalCycleTab(dir: 1 | -1): void { this.eval_.evalCycleTab(dir); }
  evalSetTab(tab: Parameters<EvalStore['evalSetTab']>[0]): void { this.eval_.evalSetTab(tab); }
  evalMove(delta: number): void { this.eval_.evalMove(delta); }
  evalOpenDetail(): void { this.eval_.evalOpenDetail(); }
  evalExit(): void { this.eval_.evalExit(); }

  // ── Findings ──
  openFindings(scanId: string, source: 'live' | 'snapshot', findings: FindingView[]): void {
    this.findings.openFindings(scanId, source, findings);
  }
  findingsMove(delta: number): void { this.findings.findingsMove(delta); }
  findingsCycleSort(dir: 1 | -1 = 1): void { this.findings.findingsCycleSort(dir); }
  findingsCycleFilter(kind: 'verdict' | 'coverage', dir: 1 | -1 = 1): void { this.findings.findingsCycleFilter(kind, dir); }
  findingsOpenDetail(): void { this.findings.findingsOpenDetail(); }
  findingsDetailStep(delta: number): void { this.findings.findingsDetailStep(delta); }
  findingsBackToTable(): void { this.findings.findingsBackToTable(); }
  findingsExit(): void { this.findings.findingsExit(); }
}
