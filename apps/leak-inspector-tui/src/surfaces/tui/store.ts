/**
 * The TUI's UI state + a tiny observable store (no external state lib). The
 * store ingests two streams — ScanEvents (phase/timeline) and raw AgentEvents
 * (assistant text + tool cards) — into a unified message list + phase map that
 * the React/Ink components render.
 */

import type { AgentEvent } from '@mcpvul/agent-core';
import {
  SCAN_PHASE_ORDER,
  ScanPhase,
  EVENT_KIND,
  EVENT_PHASE,
  type ScanEventName,
} from '@mcpvul/common/flow/scan-flow-contract';
import type { ScanEvent } from '../../orchestrator/events';
import type { AgentMeta } from '../../orchestrator/investigation';
import { toolSource, type ToolSource } from '../../domain/mcpToolPlan';
import type { EvalResult } from '../../domain/evalHarness';
import type { SnapshotFinding, LabeledFlaw, CleanSite } from '../../domain/evalScoring';

export type PhaseStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed';
export type RunStatus = 'idle' | 'running' | 'paused' | 'done' | 'error';

/** Cap on the full tool output retained for expansion (the card preview stays short). */
const MAX_TOOL_OUTPUT = 4000;

export interface ToolCardData {
  name: string;
  title: string;
  source: ToolSource;
  status: 'running' | 'ok' | 'error';
  durationMs?: number;
  /** Short preview shown when collapsed. */
  preview?: string;
  /** Full (capped) output shown when expanded. */
  output?: string;
}

export interface UiMessage {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'phase' | 'thinking';
  text?: string;
  /** Optional colour for a system line (e.g. report diff red/green); default is dim. */
  color?: string;
  tool?: ToolCardData;
  /** Which (sub-)agent produced this line; 'main' = orchestrator/main flow. */
  agentId: string;
  /** Collapsible (thinking/tool) lines start collapsed; toggled by the user. */
  collapsed?: boolean;
}

/** A spawned sub-agent shown in the agent list under the input. */
export interface AgentInfo {
  id: string;
  label: string;
  kind: AgentMeta['kind'];
  status: 'running' | 'done' | 'error';
  turns: number;
}

/** Log navigation: browsing the agent list, or inside one agent's log. */
export type NavMode = 'normal' | 'agentlist' | 'agentlog';

export interface PendingPermission {
  id: string;
  name: string;
  input: unknown;
  resolve: (decision: 'allow' | 'deny') => void;
}

export type EvalCaseStatus = 'pending' | 'running' | 'ok' | 'error' | 'skipped';

/** One benchmark case as rendered by the eval screen. */
export interface EvalCaseUi {
  id: string;
  cwe?: string;
  flowVariant?: string;
  functionalVariant?: string;
  status: EvalCaseStatus;
  /** Current phase while running (live). */
  phase?: string;
  startedAt?: number;
  durationMs?: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  candidates?: number;
  flagged?: number;
  scanId?: string;
  error?: string;
  /** Detail for the Detail tab (populated on completion). */
  findings?: SnapshotFinding[];
  flaws?: LabeledFlaw[];
  clean?: CleanSite[];
}

export type EvalTab = 'overview' | 'cases' | 'detail';

export interface EvalUiState {
  corpus: string;
  mode: string;
  dynamic: string;
  total: number;
  done: number;
  concurrency: number;
  startedAt: number;
  finishedAt?: number;
  running: boolean;
  /** A cancel was requested — draining in-flight cases, skipping the rest. */
  cancelling?: boolean;
  cases: EvalCaseUi[];
  tab: EvalTab;
  /** Cursor into `cases` for the Cases tab. */
  cursor: number;
  /** Case id pinned to the Detail tab. */
  selectedId?: string;
  /** Final aggregate (set at the end) — per-variant, calibration, cost. */
  result?: EvalResult;
  outDir?: string;
}

export interface UiState {
  messages: UiMessage[];
  phases: Record<ScanPhase, PhaseStatus>;
  currentPhase?: ScanPhase;
  status: RunStatus;
  statusText: string;
  usage: { inputTokens: number; outputTokens: number; thinkingTokens: number };
  /** Model I/O direction during a request: 'up' = sending, 'down' = receiving stream. */
  io?: 'up' | 'down';
  mode: 'no_llm' | 'llm_assisted';
  dynamic: 'off' | 'selective' | 'aggressive';
  provider: string;
  model: string;
  scanId?: string;
  reportDir?: string;
  summary?: { candidates: number; confirmed: number; likely: number };
  pendingPermission?: PendingPermission;
  startedAt?: number;
  /** Which surface to render. */
  view: 'main' | 'config' | 'eval';
  /** Benchmark evaluation state (when view === 'eval'). */
  eval?: EvalUiState;
  /** Auto-open the report findings picker when a scan finishes. */
  autoShowReport: boolean;
  /** Whether the agent invoked any dynamic-analysis tool this scan. */
  ranDynamicTool: boolean;
  /** Lines from the live bottom that the log viewport is scrolled up by (0 = live). */
  scrollOffset: number;
  /** Spawned sub-agents (static #1..#K, dynamic), shown under the input. */
  agents: AgentInfo[];
  /** Which agent's log is being viewed ('main' = orchestrator/main flow). */
  viewAgentId: string;
  /** Keyboard navigation mode for the log/agent-list. */
  navMode: NavMode;
  /** Cursor index into `agents` while navMode === 'agentlist'. */
  navIndex: number;
  /** Message id under the focus cursor while navMode === 'agentlog'. */
  focusMsgId?: string;
}

/** Messages belonging to the currently-viewed agent (main = the 'main' flow). */
export function visibleMessages(state: UiState): UiMessage[] {
  return state.messages.filter((m) => m.agentId === state.viewAgentId);
}

/** Keep the in-memory log bounded — only truncate when it grows very large. */
const MAX_HISTORY = 2000;

/** Default attribution for events with no sub-agent (orchestrator/main flow). */
const MAIN_AGENT: AgentMeta = { id: 'main', label: 'main', kind: 'main' };

function initialPhases(): Record<ScanPhase, PhaseStatus> {
  const p = {} as Record<ScanPhase, PhaseStatus>;
  for (const ph of SCAN_PHASE_ORDER) p[ph] = 'pending';
  return p;
}

type Listener = () => void;

export class TuiStore {
  private state: UiState;
  private listeners = new Set<Listener>();
  private idSeq = 0;
  private abortController?: AbortController;
  private evalAbortController?: AbortController;
  private steeringQueue: string[] = [];
  private resumeResolver?: (decision: 'resume' | 'abort') => void;

  constructor(init: Partial<UiState> = {}) {
    this.state = {
      messages: [],
      phases: initialPhases(),
      status: 'idle',
      statusText: 'idle',
      usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
      mode: 'llm_assisted',
      dynamic: 'off',
      provider: 'local',
      model: '',
      view: 'main',
      autoShowReport: false,
      ranDynamicTool: false,
      scrollOffset: 0,
      agents: [],
      viewAgentId: 'main',
      navMode: 'normal',
      navIndex: 0,
      ...init,
    };
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): UiState => this.state;

  private set(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private nextId(prefix: string): string {
    return `${prefix}_${this.idSeq++}`;
  }

  private push(msg: Omit<UiMessage, 'id' | 'agentId'> & { agentId?: string }): string {
    const id = this.nextId(msg.kind);
    const agentId = msg.agentId ?? 'main';
    let messages = [...this.state.messages, { id, ...msg, agentId }];
    let scrollOffset = this.state.scrollOffset;
    if (messages.length > MAX_HISTORY) {
      const dropped = messages.length - MAX_HISTORY;
      messages = messages.slice(dropped);
      scrollOffset = Math.max(0, scrollOffset - dropped);
    }
    // If the user has scrolled up, keep their view anchored — but only bump for a
    // line that's actually in the currently-viewed agent's log.
    if (scrollOffset > 0 && agentId === this.state.viewAgentId) scrollOffset += 1;
    this.set({ messages, scrollOffset });
    return id;
  }

  /** Scroll the log by `delta` messages, clamped to [0, maxOffset] (0 = live). */
  scrollBy(delta: number, maxOffset: number): void {
    const next = Math.max(0, Math.min(maxOffset, this.state.scrollOffset + delta));
    if (next !== this.state.scrollOffset) this.set({ scrollOffset: next });
  }

  scrollToBottom(): void {
    if (this.state.scrollOffset !== 0) this.set({ scrollOffset: 0 });
  }

  // ── Agent-log navigation ──
  /** From the main flow, drop the cursor into the agent list (if any agents). */
  enterAgentList(): void {
    if (this.state.agents.length === 0) return;
    this.set({ navMode: 'agentlist', navIndex: 0 });
  }

  /** Move the agent-list cursor; moving above the top exits back to the main flow. */
  navMove(delta: number): void {
    if (this.state.navMode !== 'agentlist') return;
    const next = this.state.navIndex + delta;
    if (next < 0) {
      this.set({ navMode: 'normal' });
      return;
    }
    this.set({ navIndex: Math.min(this.state.agents.length - 1, next) });
  }

  /** Open the selected agent's log (focus its first collapsible line). */
  openFocusedAgent(): void {
    if (this.state.navMode !== 'agentlist') return;
    const agent = this.state.agents[this.state.navIndex];
    if (!agent) return;
    const first = this.state.messages.find((m) => m.agentId === agent.id);
    this.set({ viewAgentId: agent.id, navMode: 'agentlog', focusMsgId: first?.id, scrollOffset: 0 });
  }

  /** Return from an agent's log to the main flow. */
  backToMain(): void {
    this.set({ viewAgentId: 'main', navMode: 'normal', focusMsgId: undefined, scrollOffset: 0 });
  }

  /** Move the focus cursor within the viewed agent's log, keeping it on screen. */
  logFocusMove(delta: number, viewportRows: number): void {
    if (this.state.navMode !== 'agentlog') return;
    const list = visibleMessages(this.state);
    if (list.length === 0) return;
    const cur = list.findIndex((m) => m.id === this.state.focusMsgId);
    const idx = Math.max(0, Math.min(list.length - 1, (cur < 0 ? list.length - 1 : cur) + delta));
    const focusMsgId = list[idx].id;
    // Clamp scrollOffset so the focused index stays within [end-rows, end-1].
    const rows = Math.max(1, viewportRows);
    const lower = list.length - rows - idx;
    const upper = list.length - 1 - idx;
    let scrollOffset = this.state.scrollOffset;
    if (scrollOffset < lower) scrollOffset = lower;
    if (scrollOffset > upper) scrollOffset = upper;
    scrollOffset = Math.max(0, scrollOffset);
    this.set({ focusMsgId, scrollOffset });
  }

  /** Expand/collapse the focused thinking/tool line. */
  toggleFocusedCollapse(): void {
    const id = this.state.focusMsgId;
    if (!id) return;
    const messages = this.state.messages.map((m) =>
      m.id === id && (m.kind === 'thinking' || m.kind === 'tool') ? { ...m, collapsed: !m.collapsed } : m,
    );
    this.set({ messages });
  }

  /** Register a sub-agent on first sight, or patch its status/turns. */
  private upsertAgent(agent: AgentMeta, patch?: Partial<AgentInfo>): void {
    const existing = this.state.agents.find((a) => a.id === agent.id);
    if (!existing) {
      this.set({
        agents: [...this.state.agents, { id: agent.id, label: agent.label, kind: agent.kind, status: 'running', turns: 0, ...patch }],
      });
    } else if (patch) {
      this.set({ agents: this.state.agents.map((a) => (a.id === agent.id ? { ...a, ...patch } : a)) });
    }
  }

  setIo(io: UiState['io']): void {
    if (io !== this.state.io) this.set({ io });
  }

  setView(view: UiState['view']): void {
    this.set({ view });
  }

  // ── Eval screen ──
  private patchEval(patch: Partial<EvalUiState>): void {
    if (!this.state.eval) return;
    this.set({ eval: { ...this.state.eval, ...patch } });
  }

  private patchEvalCase(id: string, patch: Partial<EvalCaseUi>): void {
    if (!this.state.eval) return;
    const cases = this.state.eval.cases.map((c) => (c.id === id ? { ...c, ...patch } : c));
    this.set({ eval: { ...this.state.eval, cases } });
  }

  beginEval(meta: {
    corpus: string;
    mode: string;
    dynamic: string;
    total: number;
    concurrency: number;
    cases: Array<Pick<EvalCaseUi, 'id' | 'cwe' | 'flowVariant' | 'functionalVariant'>>;
  }): void {
    this.set({
      view: 'eval',
      eval: {
        corpus: meta.corpus,
        mode: meta.mode,
        dynamic: meta.dynamic,
        total: meta.total,
        done: 0,
        concurrency: meta.concurrency,
        startedAt: Date.now(),
        running: true,
        cases: meta.cases.map((c) => ({ ...c, status: 'pending', tp: 0, fp: 0, fn: 0, tn: 0 })),
        tab: 'cases',
        cursor: 0,
      },
    });
  }

  evalCaseStart(id: string): void {
    this.patchEvalCase(id, { status: 'running', startedAt: Date.now(), phase: 'starting' });
  }

  evalCasePhase(id: string, phase: string): void {
    const c = this.state.eval?.cases.find((x) => x.id === id);
    if (c && c.status === 'running') this.patchEvalCase(id, { phase });
  }

  evalCaseResult(detail: {
    id: string;
    status: 'ok' | 'error' | 'skipped';
    tp: number;
    fp: number;
    fn: number;
    tn: number;
    candidates?: number;
    flagged?: number;
    durationMs?: number;
    scanId?: string;
    error?: string;
    findings?: SnapshotFinding[];
    flaws?: LabeledFlaw[];
    clean?: CleanSite[];
  }): void {
    if (!this.state.eval) return;
    const { id, ...rest } = detail;
    this.patchEvalCase(id, { ...rest, phase: undefined });
    this.patchEval({ done: this.state.eval.done + 1 });
  }

  endEval(result: EvalResult, outDir: string): void {
    this.evalAbortController = undefined;
    this.patchEval({ running: false, cancelling: false, finishedAt: Date.now(), result, outDir });
  }

  /** Register the controller that `evalAbort` trips (set by the eval runner). */
  setEvalAbort(ac: AbortController | undefined): void {
    this.evalAbortController = ac;
  }

  /**
   * Cancel a running eval: abort in-flight cases and mark every not-yet-started
   * case skipped. Completed cases keep their results — the run still finalizes a
   * report over whatever finished.
   */
  evalAbort(): void {
    if (!this.state.eval || !this.state.eval.running || this.state.eval.cancelling) return;
    this.evalAbortController?.abort();
    const cases = this.state.eval.cases.map((c) =>
      c.status === 'pending' ? { ...c, status: 'skipped' as const } : c,
    );
    this.set({ eval: { ...this.state.eval, cancelling: true, cases } });
  }

  evalCycleTab(dir: 1 | -1): void {
    if (!this.state.eval) return;
    const order: EvalTab[] = ['overview', 'cases', 'detail'];
    const i = order.indexOf(this.state.eval.tab);
    this.patchEval({ tab: order[(i + dir + order.length) % order.length] });
  }

  evalSetTab(tab: EvalTab): void {
    this.patchEval({ tab });
  }

  /** Move the case cursor (Cases tab). */
  evalMove(delta: number): void {
    if (!this.state.eval) return;
    const n = this.state.eval.cases.length;
    if (n === 0) return;
    this.patchEval({ cursor: Math.max(0, Math.min(n - 1, this.state.eval.cursor + delta)) });
  }

  /** Pin the case under the cursor to the Detail tab and switch to it. */
  evalOpenDetail(): void {
    if (!this.state.eval) return;
    const c = this.state.eval.cases[this.state.eval.cursor];
    if (c) this.patchEval({ selectedId: c.id, tab: 'detail' });
  }

  /** Leave the eval screen back to the main flow. */
  evalExit(): void {
    this.set({ view: 'main' });
  }

  setAutoShowReport(autoShowReport: boolean): void {
    this.set({ autoShowReport });
  }

  // ── User-facing actions ──
  addUserMessage(text: string): void {
    this.push({ kind: 'user', text });
  }

  addSystemMessage(text: string, color?: string): void {
    this.push({ kind: 'system', text, ...(color ? { color } : {}) });
  }

  setOptions(opts: Partial<Pick<UiState, 'mode' | 'dynamic' | 'provider' | 'model'>>): void {
    this.set(opts);
  }

  setAbortController(ac: AbortController | undefined): void {
    this.abortController = ac;
  }

  /** Interrupt the running scan, or stop a paused agent (ESC). */
  abort(): void {
    // Paused waiting for the user → ESC stops the run.
    if (this.resumeResolver) {
      const resolve = this.resumeResolver;
      this.resumeResolver = undefined;
      this.push({ kind: 'system', text: '⎋ stopping…' });
      this.set({ statusText: 'stopping…' });
      resolve('abort');
      return;
    }
    if (this.state.status !== 'running' || !this.abortController) return;
    this.abortController.abort();
    this.push({ kind: 'system', text: '⎋ interrupting…' });
    this.set({ statusText: 'interrupting…' });
  }

  /** The loop awaits this when the model fails; resolves when the user resumes or aborts. */
  awaitResume(): Promise<'resume' | 'abort'> {
    return new Promise((resolve) => {
      this.resumeResolver = resolve;
    });
  }

  /** Resume a paused agent (the user typed "continue" or new guidance). */
  resume(): void {
    if (this.state.status !== 'paused' || !this.resumeResolver) return;
    const resolve = this.resumeResolver;
    this.resumeResolver = undefined;
    this.set({ status: 'running', statusText: 'resuming…' });
    resolve('resume');
  }

  isPaused(): boolean {
    return this.state.status === 'paused';
  }

  isRunning(): boolean {
    return this.state.status === 'running';
  }

  /** Queue a steering message to inject into the agent at its next turn. */
  enqueueSteering(text: string): void {
    this.steeringQueue.push(text);
  }

  /** Drained by the loop each turn. */
  drainSteering(): string[] {
    if (this.steeringQueue.length === 0) return [];
    const out = this.steeringQueue;
    this.steeringQueue = [];
    return out;
  }

  beginRun(scanId: string, mode: UiState['mode']): void {
    this.steeringQueue = [];
    this.resumeResolver = undefined;
    // Keep prior scans in the scrollback but separate them visually.
    if (this.state.messages.length > 0) this.push({ kind: 'phase', text: '── new scan ──' });
    // Per-scan reset: tokens, phases, summary, I/O cue, and dynamic-usage tracking
    // all start fresh so a second scan never inherits the first's counters.
    this.set({
      status: 'running',
      statusText: 'starting…',
      scanId,
      mode,
      phases: initialPhases(),
      summary: undefined,
      reportDir: undefined,
      currentPhase: undefined,
      io: undefined,
      usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
      ranDynamicTool: false,
      scrollOffset: 0,
      agents: [],
      viewAgentId: 'main',
      navMode: 'normal',
      navIndex: 0,
      focusMsgId: undefined,
      startedAt: Date.now(),
    });
  }

  finishRun(reportDir: string, summary: UiState['summary']): void {
    if (this.state.dynamic !== 'off' && !this.state.ranDynamicTool) {
      this.push({
        kind: 'system',
        text:
          '⚠ dynamic was enabled but the agent ran no dynamic tools — the model judged static evidence ' +
          'sufficient (selective). Use /config or /dynamic → aggressive to force a run.',
      });
    }
    this.set({ status: 'done', statusText: 'done', reportDir, summary, io: undefined });
  }

  failRun(message: string): void {
    this.push({ kind: 'system', text: `✗ ${message}` });
    this.set({ status: 'error', statusText: 'error' });
  }

  // ── ScanEvent stream → phase map + phase banners ──
  applyScanEvent(ev: ScanEvent): void {
    if (ev.data?.warning) this.push({ kind: 'system', text: `⚠ ${String(ev.data.warning)}` });
    if (ev.data?.detectedAnalyzerRoot)
      this.push({ kind: 'system', text: `↳ mapped repo to analyzer root ${String(ev.data.detectedAnalyzerRoot)}` });
    const phase = EVENT_PHASE[ev.name as ScanEventName] ?? ev.phase;
    const kind = EVENT_KIND[ev.name as ScanEventName];
    if (phase) {
      const phases = { ...this.state.phases };
      if (kind === 'phase_start') {
        phases[phase] = 'active';
        this.set({ phases, currentPhase: phase, statusText: phase });
        this.push({ kind: 'phase', text: phaseLabel(phase) });
      } else if (kind === 'phase_finish') {
        phases[phase] = 'done';
        this.set({ phases });
      } else if (kind === 'terminal') {
        if (ev.name.toString().includes('fail')) phases[phase] = 'failed';
        else phases[phase] = 'done';
        this.set({ phases });
      } else {
        this.set({ statusText: `${phase}: ${shortName(ev.name)}` });
      }
    }
  }

  // ── AgentEvent stream → assistant text + tool cards ──
  private toolMsgByUseId = new Map<string, string>();

  applyAgentEvent(ev: AgentEvent, agent: AgentMeta = MAIN_AGENT): void {
    const agentId = agent.id;
    if (agent.kind !== 'main') this.upsertAgent(agent);
    switch (ev.type) {
      case 'thinking':
        // thinking/tool start collapsed — expand from the agent's log view.
        if (ev.text?.trim()) this.push({ kind: 'thinking', text: ev.text.trim(), agentId, collapsed: true });
        break;
      case 'assistant_text':
        if (ev.text?.trim()) this.push({ kind: 'assistant', text: ev.text.trim(), agentId });
        break;
      case 'tool_use': {
        // Model finished generating this turn's request → no longer sending/receiving.
        if (this.state.io) this.set({ io: undefined });
        if (toolSource(ev.name) === 'mcp-dynamic' && !this.state.ranDynamicTool) {
          this.set({ ranDynamicTool: true });
        }
        const title = `${displayToolName(ev.name)}${summarizeInput(ev.input)}`;
        const msgId = this.push({
          kind: 'tool',
          agentId,
          collapsed: true,
          tool: { name: ev.name, title, source: toolSource(ev.name), status: 'running' },
        });
        this.toolMsgByUseId.set(ev.id, msgId);
        break;
      }
      case 'tool_result': {
        const msgId = this.toolMsgByUseId.get(ev.id);
        if (msgId) {
          const messages = this.state.messages.map((m) =>
            m.id === msgId && m.tool
              ? {
                  ...m,
                  tool: {
                    ...m.tool,
                    status: ev.isError ? ('error' as const) : ('ok' as const),
                    durationMs: ev.durationMs,
                    preview: previewOutput(ev.output, 160),
                    output: previewOutput(ev.output, MAX_TOOL_OUTPUT),
                  },
                }
              : m,
          );
          this.set({ messages });
        }
        break;
      }
      case 'turn_end':
        if (ev.usage) {
          this.set({
            usage: {
              inputTokens: this.state.usage.inputTokens + ev.usage.inputTokens,
              outputTokens: this.state.usage.outputTokens + ev.usage.outputTokens,
              thinkingTokens: this.state.usage.thinkingTokens + (ev.usage.thinkingTokens ?? 0),
            },
          });
        }
        if (agent.kind !== 'main') this.upsertAgent(agent, { turns: (this.state.agents.find((a) => a.id === agentId)?.turns ?? 0) + 1 });
        if (this.state.io) this.set({ io: undefined });
        break;
      case 'notice':
        this.push({ kind: 'system', text: `↻ ${ev.text}`, agentId });
        this.set({ statusText: ev.text });
        break;
      case 'paused':
        this.push({
          kind: 'system',
          agentId,
          text: `⏸ agent paused (${ev.reason}) — type "continue" or add guidance to resume, ESC to stop`,
        });
        this.set({ status: 'paused', statusText: 'paused — awaiting your input' });
        break;
      case 'resumed':
        this.push({ kind: 'system', text: '▶ resumed', agentId });
        this.set({ status: 'running', statusText: 'resuming…' });
        break;
      case 'error':
        this.push({ kind: 'system', text: `⚠ agent error: ${ev.message}`, agentId });
        if (agent.kind !== 'main') this.upsertAgent(agent, { status: 'error' });
        break;
      case 'done':
        if (this.state.io) this.set({ io: undefined });
        if (agent.kind !== 'main') this.upsertAgent(agent, { status: ev.reason === 'error' ? 'error' : 'done' });
        if (ev.reason === 'max_turns') this.push({ kind: 'system', text: '⚠ investigation hit the turn limit', agentId });
        break;
    }
  }

  // ── Permission prompt ──
  requestPermission(req: { id: string; name: string; input: unknown }): Promise<'allow' | 'deny'> {
    return new Promise((resolve) => {
      this.set({
        pendingPermission: {
          ...req,
          resolve: (decision) => {
            this.set({ pendingPermission: undefined });
            resolve(decision);
          },
        },
      });
    });
  }

  resolvePermission(decision: 'allow' | 'deny'): void {
    this.state.pendingPermission?.resolve(decision);
  }
}

function phaseLabel(phase: ScanPhase): string {
  return `── ${phase.toUpperCase()} ──`;
}

/** Show the actual tool a slot runs (the leakguard slot is the Clang scan-build analyzer). */
const TOOL_DISPLAY: Record<string, string> = {
  leakguardRun: 'clang-sa:scan-build',
  leakguardGetReport: 'clang-sa:get-report',
};
function displayToolName(name: string): string {
  return TOOL_DISPLAY[name] ?? name;
}

function shortName(name: string): string {
  return name.replace(/_/g, ' ');
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const key = (o.functionName ?? o.bundleId ?? o.path ?? o.filePath ?? o.rootPath) as string | undefined;
  return key ? ` ${shortPath(String(key))}` : '';
}

function shortPath(p: string): string {
  const parts = p.split('/');
  return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/');
}

function previewOutput(output: unknown, max: number): string {
  if (output == null) return '';
  if (typeof output === 'string') return output.slice(0, max);
  try {
    return JSON.stringify(output).slice(0, max);
  } catch {
    return '';
  }
}
