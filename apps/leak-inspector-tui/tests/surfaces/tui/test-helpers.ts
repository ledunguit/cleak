/**
 * Test helper for the Zustand migration (Phase 5d).
 *
 * Provides a `createTestState()` adapter that mimics the old `TuiStore` API
 * while delegating to Zustand singleton stores (scanStore, configStore, etc.).
 *
 * Use in tests instead of `new TuiStore()`:
 *   const store = createTestState();
 *   const store = createTestState({ dynamic: 'selective' });
 *
 * Also exports `resetStores()` for explicit beforeEach cleanup.
 */

import { scanStore } from '../../../src/stores/scan-store';
import { configStore } from '../../../src/stores/config-store';
import { navigationStore } from '../../../src/stores/navigation-store';
import { evalStore } from '../../../src/stores/eval-store';
import { findingsStore } from '../../../src/stores/findings-store';
import type { AgentEvent } from '@cleak/agent-core';
import type { AgentMeta } from '../../../src/orchestrator/investigation';
import type { FindingView } from '../../../src/surfaces/tui/findings/findingView';
import type { UiState } from '../../../src/stores/types';

// ── Reset all stores to their initial state ──

export function resetStores(): void {
  scanStore.setState({
    messages: [],
    ranDynamicTool: false,
    scrollOffset: 0,
    agents: [],
    status: 'idle',
    statusText: 'idle',
    usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
  });
  configStore.setState({
    mode: 'llm_assisted',
    dynamic: 'off',
    provider: 'local',
    model: '',
    autoShowReport: false,
    permissionMode: 'ask',
    pendingPermission: undefined,
  });
  navigationStore.setState({
    view: 'main',
    navMode: 'normal',
    navIndex: 0,
    viewAgentId: 'main',
  });
  evalStore.setState({
    corpus: '',
    mode: '',
    dynamic: '',
    total: 0,
    done: 0,
    concurrency: 1,
    startedAt: 0,
    running: false,
    cases: [],
    tab: 'cases',
    cursor: 0,
  });
  findingsStore.setState({
    scanId: '',
    source: 'live',
    findings: [],
    cursor: 0,
    sort: 'severity',
    filter: {},
    tab: 'table',
  });
}

// ── Build a merged UiState from all sub-stores ──

function buildSnapshot(): UiState {
  const s = scanStore.getState();
  const c = configStore.getState();
  const n = navigationStore.getState();
  const es = evalStore.getState();
  const fs = findingsStore.getState();

  const findings: UiState['findings'] = fs.scanId
    ? {
        scanId: fs.scanId,
        source: fs.source,
        findings: fs.findings,
        cursor: fs.cursor,
        sort: fs.sort,
        filter: fs.filter,
        tab: fs.tab,
        detailId: fs.detailId,
      }
    : undefined;

  const evalUi: UiState['eval'] = es.corpus
    ? {
        corpus: es.corpus,
        mode: es.mode,
        dynamic: es.dynamic,
        total: es.total,
        done: es.done,
        concurrency: es.concurrency,
        startedAt: es.startedAt,
        finishedAt: es.finishedAt,
        running: es.running,
        cancelling: es.cancelling,
        cases: es.cases,
        tab: es.tab,
        cursor: es.cursor,
        selectedId: es.selectedId,
        result: es.result,
        outDir: es.outDir,
      }
    : undefined;

  return {
    messages: s.messages,
    phases: s.phases,
    currentPhase: s.currentPhase,
    status: s.status,
    statusText: s.statusText,
    usage: s.usage,
    io: s.io,
    mode: c.mode,
    dynamic: c.dynamic,
    provider: c.provider,
    model: c.model,
    baseUrl: c.baseUrl,
    apiKey: c.apiKey,
    view: n.view,
    autoShowReport: c.autoShowReport,
    permissionMode: c.permissionMode,
    pendingPermission: c.pendingPermission,
    ranDynamicTool: s.ranDynamicTool,
    scrollOffset: s.scrollOffset,
    agents: s.agents,
    viewAgentId: n.viewAgentId,
    navMode: n.navMode,
    navIndex: n.navIndex,
    focusMsgId: n.focusMsgId ?? s.focusMsgId,
    scanId: s.scanId,
    reportDir: s.reportDir,
    summary: s.summary,
    startedAt: s.startedAt,
    eval: evalUi,
    findings,
  };
}

/**
 * Minimal interface matching the TuiStore surface used by tests.
 */
export interface TestTuiStore {
  subscribe(l: () => void): () => void;
  getState(): UiState;
  getSnapshot(): UiState;
  setView(view: UiState['view']): void;
  enterAgentList(): void;
  navMove(delta: number): void;
  openFocusedAgent(): void;
  backToMain(): void;
  logFocusMove(delta: number, viewportRows: number): void;
  toggleFocusedCollapse(): void;
  setOptions(opts: Partial<Pick<UiState, 'mode' | 'dynamic' | 'provider' | 'model' | 'baseUrl' | 'apiKey'>>): void;
  setAutoShowReport(auto: boolean): void;
  cyclePermissionMode(): 'ask' | 'auto';
  requestPermission(req: { id: string; name: string; input: unknown }): Promise<'allow' | 'deny'>;
  resolvePermission(decision: 'allow' | 'deny'): void;
  beginRun(scanId: string, mode: UiState['mode']): void;
  finishRun(reportDir: string, summary: UiState['summary']): void;
  failRun(message: string): void;
  applyScanEvent(ev: never): void;
  applyAgentEvent(ev: AgentEvent, agent?: AgentMeta): void;
  scrollBy(delta: number, maxOffset: number): void;
  scrollToBottom(): void;
  setIo(io: UiState['io']): void;
  addUserMessage(text: string): void;
  addSystemMessage(text: string, color?: string): void;
  abort(): void;
  isPaused(): boolean;
  isRunning(): boolean;
  push(msg: never): string;
  updateMessage(id: string, updater: (m: unknown) => unknown): void;
  openFindings(scanId: string, source: 'live' | 'snapshot', findings: FindingView[]): void;
  findingsMove(delta: number): void;
  findingsCycleSort(dir?: 1 | -1): void;
  findingsCycleFilter(kind: 'verdict' | 'coverage', dir?: 1 | -1): void;
  findingsOpenDetail(): void;
  findingsDetailStep(delta: number): void;
  findingsBackToTable(): void;
  findingsExit(): void;
}

/**
 * Create a TuiStore-compatible adapter backed by Zustand singleton stores.
 *
 * - Resets all stores to initial state.
 * - If `init.dynamic` is provided, it is applied via configStore.
 * - Returns an object whose `getSnapshot()` assembles a unified UiState
 *   from the sub-stores on every call, and whose methods delegate to the
 *   appropriate Zustand store's actions.
 *
 * Call this in each test (or in a beforeEach helper) where you previously
 * wrote `new TuiStore()` / `new TuiStore({ dynamic: 'selective' })`.
 */
export function createTestState(init?: { dynamic?: UiState['dynamic'] }): TestTuiStore {
  resetStores();

  if (init?.dynamic) {
    configStore.getState().setOptions({ dynamic: init.dynamic });
  }

  // Wire configStore cross-store callback (normally done in TuiStore constructor).
  configStore.getState().setPushSystem((text, color) => {
    scanStore.getState().addSystemMessage(text, color);
  });

  return {
    subscribe() {
      return () => {};
    },
    getState: buildSnapshot,
    getSnapshot: buildSnapshot,

    // ── Navigation ──
    setView(view) {
      navigationStore.getState().setView(view);
    },
    enterAgentList() {
      navigationStore.getState().enterAgentList();
    },
    navMove(delta) {
      navigationStore.getState().navMove(delta);
    },
    openFocusedAgent() {
      const navState = navigationStore.getState();
      const agents = scanStore.getState().agents;
      const agent = agents[navState.navIndex];
      navState.openFocusedAgent();
      const agentId = agent?.id ?? 'main';
      const messages = scanStore.getState().messages;
      const firstMsg = messages.find((m) => m.agentId === agentId);
      navigationStore.setState({
        viewAgentId: agentId,
        navMode: 'agentlog',
        focusMsgId: firstMsg?.id,
      });
    },
    backToMain() {
      navigationStore.setState({
        viewAgentId: 'main',
        navMode: 'normal',
        focusMsgId: undefined,
      });
    },
    logFocusMove(delta, _viewportRows) {
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
    },
    toggleFocusedCollapse() {
      const { focusMsgId } = navigationStore.getState();
      if (focusMsgId) {
        scanStore.getState().updateMessage(focusMsgId, (m) => ({
          ...m,
          collapsed: !m.collapsed,
        }));
      }
    },

    // ── Config ──
    setOptions(opts) {
      configStore.getState().setOptions(opts);
    },
    setAutoShowReport(auto) {
      configStore.getState().setAutoShowReport(auto);
    },
    cyclePermissionMode() {
      return configStore.getState().cyclePermissionMode();
    },
    requestPermission(req) {
      return configStore.getState().requestPermission(req);
    },
    resolvePermission(decision) {
      configStore.getState().resolvePermission(decision);
    },

    // ── Scan ──
    beginRun(scanId, _mode) {
      scanStore.getState().beginRun(scanId);
      navigationStore.getState().resetForNewScan();
    },
    finishRun(reportDir, summary) {
      const c = configStore.getState();
      const s = scanStore.getState();
      if (c.dynamic !== 'off' && !s.ranDynamicTool) {
        s.addSystemMessage(
          '⚠ dynamic was enabled but the agent ran no dynamic tools — the model judged static evidence sufficient (selective). Use /config or /dynamic → aggressive to force a run.',
        );
      }
      s.finishRun(reportDir, summary);
    },
    failRun(message) {
      scanStore.getState().failRun(message);
    },
    applyScanEvent(ev) {
      scanStore.getState().applyScanEvent(ev as never);
    },
    applyAgentEvent(ev, agent?) {
      scanStore.getState().applyAgentEvent(ev, agent);
    },
    scrollBy(delta, maxOffset) {
      scanStore.getState().scrollBy(delta, maxOffset);
    },
    scrollToBottom() {
      scanStore.getState().scrollToBottom();
    },
    setIo(io) {
      scanStore.getState().setIo(io);
    },
    addUserMessage(text) {
      scanStore.getState().addUserMessage(text);
    },
    addSystemMessage(text, color?) {
      scanStore.getState().addSystemMessage(text, color);
    },
    abort() {
      scanStore.getState().abort();
    },
    isPaused() {
      return scanStore.getState().isPaused();
    },
    isRunning() {
      return scanStore.getState().isRunning();
    },
    push(msg) {
      return scanStore.getState().push(msg as never);
    },
    updateMessage(id, updater) {
      scanStore.getState().updateMessage(id, updater as never);
    },

    // ── Findings ──
    openFindings(scanId, source, findings) {
      findingsStore.getState().openFindings(scanId, source, findings);
      navigationStore.getState().setView('findings');
    },
    findingsMove(delta) {
      findingsStore.getState().findingsMove(delta);
    },
    findingsCycleSort(dir) {
      findingsStore.getState().findingsCycleSort(dir);
    },
    findingsCycleFilter(kind, dir) {
      findingsStore.getState().findingsCycleFilter(kind, dir);
    },
    findingsOpenDetail() {
      findingsStore.getState().findingsOpenDetail();
    },
    findingsDetailStep(delta) {
      findingsStore.getState().findingsDetailStep(delta);
    },
    findingsBackToTable() {
      findingsStore.getState().findingsBackToTable();
    },
    findingsExit() {
      findingsStore.getState().findingsExit();
      navigationStore.getState().setView('main');
    },
  };
}
