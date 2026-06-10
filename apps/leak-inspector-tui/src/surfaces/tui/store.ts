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
import { toolSource, type ToolSource } from '../../domain/mcpToolPlan';

export type PhaseStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed';
export type RunStatus = 'idle' | 'running' | 'paused' | 'done' | 'error';

export interface ToolCardData {
  name: string;
  title: string;
  source: ToolSource;
  status: 'running' | 'ok' | 'error';
  durationMs?: number;
  preview?: string;
}

export interface UiMessage {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'phase' | 'thinking';
  text?: string;
  /** Optional colour for a system line (e.g. report diff red/green); default is dim. */
  color?: string;
  tool?: ToolCardData;
}

export interface PendingPermission {
  id: string;
  name: string;
  input: unknown;
  resolve: (decision: 'allow' | 'deny') => void;
}

export interface UiState {
  messages: UiMessage[];
  phases: Record<ScanPhase, PhaseStatus>;
  currentPhase?: ScanPhase;
  status: RunStatus;
  statusText: string;
  usage: { inputTokens: number; outputTokens: number };
  mode: 'no_llm' | 'llm_assisted';
  dynamic: 'off' | 'selective' | 'aggressive';
  provider: string;
  model: string;
  scanId?: string;
  reportDir?: string;
  summary?: { candidates: number; confirmed: number; likely: number };
  pendingPermission?: PendingPermission;
  startedAt?: number;
}

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
  private steeringQueue: string[] = [];
  private resumeResolver?: (decision: 'resume' | 'abort') => void;

  constructor(init: Partial<UiState> = {}) {
    this.state = {
      messages: [],
      phases: initialPhases(),
      status: 'idle',
      statusText: 'idle',
      usage: { inputTokens: 0, outputTokens: 0 },
      mode: 'llm_assisted',
      dynamic: 'off',
      provider: 'local',
      model: '',
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

  private push(msg: Omit<UiMessage, 'id'>): string {
    const id = this.nextId(msg.kind);
    this.set({ messages: [...this.state.messages, { id, ...msg }] });
    return id;
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
    this.set({
      status: 'running',
      statusText: 'starting…',
      scanId,
      mode,
      phases: initialPhases(),
      summary: undefined,
      startedAt: Date.now(),
    });
  }

  finishRun(reportDir: string, summary: UiState['summary']): void {
    this.set({ status: 'done', statusText: 'done', reportDir, summary });
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

  applyAgentEvent(ev: AgentEvent): void {
    switch (ev.type) {
      case 'thinking':
        if (ev.text?.trim()) this.push({ kind: 'thinking', text: ev.text.trim() });
        break;
      case 'assistant_text':
        if (ev.text?.trim()) this.push({ kind: 'assistant', text: ev.text.trim() });
        break;
      case 'tool_use': {
        const title = `${displayToolName(ev.name)}${summarizeInput(ev.input)}`;
        const msgId = this.push({
          kind: 'tool',
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
                    preview: previewOutput(ev.output),
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
            },
          });
        }
        break;
      case 'notice':
        this.push({ kind: 'system', text: `↻ ${ev.text}` });
        this.set({ statusText: ev.text });
        break;
      case 'paused':
        this.push({
          kind: 'system',
          text: `⏸ agent paused (${ev.reason}) — type "continue" or add guidance to resume, ESC to stop`,
        });
        this.set({ status: 'paused', statusText: 'paused — awaiting your input' });
        break;
      case 'resumed':
        this.push({ kind: 'system', text: '▶ resumed' });
        this.set({ status: 'running', statusText: 'resuming…' });
        break;
      case 'error':
        this.push({ kind: 'system', text: `⚠ agent error: ${ev.message}` });
        break;
      case 'done':
        if (ev.reason === 'max_turns') this.push({ kind: 'system', text: '⚠ investigation hit the turn limit' });
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

function previewOutput(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output.slice(0, 160);
  try {
    return JSON.stringify(output).slice(0, 160);
  } catch {
    return '';
  }
}
