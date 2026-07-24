/**
 * Scan sub-store (Zustand) — message timeline, phase tracking, scan lifecycle, agent
 * event ingestion. Houses the hot-path `applyAgentEvent` with targeted
 * `updateMessage(id, updater)` instead of a full-array clone for tool_result.
 *
 * Migration note: converted from surfaces/tui/store/scan-store.ts class.
 */

import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';
import type { AgentEvent } from '@cleak/agent-core';
import { EVENT_KIND, EVENT_PHASE, type ScanEventName, type ScanPhase } from '@cleak/common/flow/scan-flow-contract';
import type { ScanEvent } from '../orchestrator/events';
import type { AgentMeta } from '../orchestrator/investigation';
import { toolSource } from '../domain/mcpToolPlan';
import type { UiMessage, AgentInfo, RunStatus, PhaseStatus } from './types';
import {
  phaseLabel,
  displayToolName,
  shortName,
  summarizeInput,
  previewOutput,
  initialPhases,
} from '../surfaces/tui/store/scan-helpers';

const MAX_HISTORY = 2000;
const MAX_TOOL_OUTPUT = 4000;
const MAIN_AGENT: AgentMeta = { id: 'main', label: 'main', kind: 'main' };

// ─── State & Actions interfaces ──────────────────────────────────────────

export interface ScanState {
  messages: UiMessage[];
  phases: Record<ScanPhase, PhaseStatus>;
  currentPhase?: ScanPhase;
  status: RunStatus;
  statusText: string;
  usage: { inputTokens: number; outputTokens: number; thinkingTokens: number };
  io?: 'up' | 'down';
  scanId?: string;
  reportDir?: string;
  summary?: { candidates: number; confirmed: number; likely: number };
  startedAt?: number;
  ranDynamicTool: boolean;
  scrollOffset: number;
  agents: AgentInfo[];
  focusMsgId?: string;
}

export interface ScanActions {
  push(msg: Omit<UiMessage, 'id' | 'agentId'> & { agentId?: string }): string;
  updateMessage(id: string, updater: (m: UiMessage) => UiMessage): void;
  scrollBy(delta: number, maxOffset: number): void;
  scrollToBottom(): void;
  addUserMessage(text: string): void;
  addSystemMessage(text: string, color?: string): void;
  setIo(io: ScanState['io']): void;
  setAbortController(ac: AbortController | undefined): void;
  abort(): void;
  awaitResume(): Promise<'resume' | 'abort'>;
  resume(): void;
  isPaused(): boolean;
  isRunning(): boolean;
  enqueueSteering(text: string): void;
  drainSteering(): string[];
  beginRun(scanId: string): void;
  finishRun(reportDir: string, summary: ScanState['summary']): void;
  failRun(message: string): void;
  applyScanEvent(ev: ScanEvent): void;
  applyAgentEvent(ev: AgentEvent, agent?: AgentMeta): void;
}

// ─── Private helpers (not exported) ──────────────────────────────────────

function upsertAgent(
  agents: AgentInfo[],
  meta: AgentMeta,
  patch?: Partial<AgentInfo>,
): AgentInfo[] {
  const existing = agents.find((a) => a.id === meta.id);
  if (!existing) {
    return [
      ...agents,
      {
        id: meta.id,
        label: meta.label,
        kind: meta.kind,
        status: 'running' as const,
        turns: 0,
        ...patch,
      },
    ];
  }
  if (patch) {
    return agents.map((a) => (a.id === meta.id ? { ...a, ...patch } : a));
  }
  return agents;
}

// ─── Store creation ──────────────────────────────────────────────────────

export const scanStore = createStore<ScanState & ScanActions>()(subscribeWithSelector((set, get) => {
  // Private fields (outside Zustand state, not reactive)
  let idSeq = 0;
  let abortController: AbortController | undefined;
  let steeringQueue: string[] = [];
  let resumeResolver: ((decision: 'resume' | 'abort') => void) | undefined;
  const toolMsgByUseId = new Map<string, string>();

  const nextId = (prefix: string) => `${prefix}_${idSeq++}`;

  return {
    // ─── Initial state ────────────────────────────────────────────────
    messages: [],
    phases: initialPhases(),
    status: 'idle' as RunStatus,
    statusText: '',
    usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
    ranDynamicTool: false,
    scrollOffset: 0,
    agents: [],

    // ─── Actions ──────────────────────────────────────────────────────

    push(msg) {
      const id = nextId(msg.kind);
      const agentId = msg.agentId ?? 'main';
      const state = get();
      let messages = [...state.messages, { id, ...msg, agentId }];
      let scrollOffset = state.scrollOffset;
      if (messages.length > MAX_HISTORY) {
        const dropped = messages.length - MAX_HISTORY;
        messages = messages.slice(dropped);
        scrollOffset = Math.max(0, scrollOffset - dropped);
      }
      set({ messages, scrollOffset });
      return id;
    },

    updateMessage(id, updater) {
      const msgs = get().messages;
      const idx = msgs.findIndex((m) => m.id === id);
      if (idx < 0) return;
      const next = msgs.slice();
      next[idx] = updater(next[idx]);
      set({ messages: next });
    },

    scrollBy(delta, maxOffset) {
      const s = get();
      const next = Math.max(0, Math.min(maxOffset, s.scrollOffset + delta));
      if (next !== s.scrollOffset) set({ scrollOffset: next });
    },

    scrollToBottom() {
      if (get().scrollOffset !== 0) set({ scrollOffset: 0 });
    },

    addUserMessage(text) {
      get().push({ kind: 'user', text });
    },

    addSystemMessage(text, color?) {
      get().push({ kind: 'system', text, ...(color ? { color } : {}) });
    },

    setIo(io) {
      if (io !== get().io) set({ io });
    },

    setAbortController(ac) {
      abortController = ac;
    },

    abort() {
      if (resumeResolver) {
        const resolve = resumeResolver;
        resumeResolver = undefined;
        get().push({ kind: 'system', text: '⎋ stopping…' });
        set({ statusText: 'stopping…' });
        resolve('abort');
        return;
      }
      const s = get();
      if (s.status !== 'running' || !abortController) return;
      abortController.abort();
      get().push({ kind: 'system', text: '⎋ interrupting…' });
      set({ statusText: 'interrupting…' });
    },

    awaitResume() {
      return new Promise((resolve) => {
        resumeResolver = resolve;
      });
    },

    resume() {
      const s = get();
      if (s.status !== 'paused' || !resumeResolver) return;
      const resolve = resumeResolver;
      resumeResolver = undefined;
      set({ status: 'running' as RunStatus, statusText: 'resuming…' });
      resolve('resume');
    },

    isPaused() {
      return get().status === 'paused';
    },

    isRunning() {
      return get().status === 'running';
    },

    enqueueSteering(text) {
      steeringQueue.push(text);
    },

    drainSteering() {
      if (steeringQueue.length === 0) return [];
      const out = steeringQueue;
      steeringQueue = [];
      return out;
    },

    beginRun(scanId) {
      steeringQueue = [];
      resumeResolver = undefined;
      const s = get();
      if (s.messages.length > 0) {
        const id = nextId('phase');
        set({
          messages: [
            ...s.messages,
            { id, kind: 'phase' as const, text: '── new scan ──', agentId: 'main' },
          ],
        });
      }
      set({
        status: 'running' as RunStatus,
        statusText: 'starting…',
        scanId,
        phases: initialPhases(),
        summary: undefined,
        reportDir: undefined,
        currentPhase: undefined,
        io: undefined,
        usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
        ranDynamicTool: false,
        scrollOffset: 0,
        agents: [],
        startedAt: Date.now(),
      });
    },

    finishRun(reportDir, summary) {
      // NOTE: `dynamic` config check removed (belongs to configStore — handled by adapter)
      set({ status: 'done' as RunStatus, statusText: 'done', reportDir, summary, io: undefined });
    },

    failRun(message) {
      get().push({ kind: 'system', text: `✗ ${message}` });
      set({ status: 'error' as RunStatus, statusText: 'error' });
    },

    applyScanEvent(ev) {
      if (ev.data?.warning) get().push({ kind: 'system', text: `⚠ ${String(ev.data.warning)}` });
      if (ev.data?.detectedAnalyzerRoot)
        get().push({ kind: 'system', text: `↳ mapped repo to analyzer root ${String(ev.data.detectedAnalyzerRoot)}` });
      const phase: ScanPhase | undefined = EVENT_PHASE[ev.name as ScanEventName] ?? ev.phase;
      const kind = EVENT_KIND[ev.name as ScanEventName];
      if (!phase) return;
      const s = get();
      const phases = { ...s.phases };
      if (kind === 'phase_start') {
        phases[phase] = 'active';
        set({ phases, currentPhase: phase, statusText: phase });
        get().push({ kind: 'phase', text: phaseLabel(phase) });
      } else if (kind === 'phase_finish') {
        phases[phase] = 'done';
        set({ phases });
      } else if (kind === 'terminal') {
        phases[phase] = ev.name.toString().includes('fail') ? 'failed' : 'done';
        set({ phases });
      } else {
        set({ statusText: `${phase}: ${shortName(ev.name)}` });
      }
    },

    // ── AgentEvent stream → assistant text + tool cards ──
    applyAgentEvent(ev, agent?) {
      const agentMeta = agent ?? MAIN_AGENT;
      const agentId = agentMeta.id;
      if (agentMeta.kind !== 'main') {
        set({ agents: upsertAgent(get().agents, agentMeta) });
      }
      switch (ev.type) {
        case 'thinking':
          if (ev.text?.trim()) get().push({ kind: 'thinking', text: ev.text.trim(), agentId, collapsed: true });
          break;
        case 'assistant_text':
          if (ev.text?.trim()) get().push({ kind: 'assistant', text: ev.text.trim(), agentId });
          break;
        case 'tool_use': {
          if (get().io) set({ io: undefined });
          if (toolSource(ev.name) === 'mcp-dynamic' && !get().ranDynamicTool) set({ ranDynamicTool: true });
          const title = `${displayToolName(ev.name)}${summarizeInput(ev.input)}`;
          const msgId = get().push({
            kind: 'tool',
            agentId,
            collapsed: true,
            tool: { name: ev.name, title, source: toolSource(ev.name), status: 'running' },
          });
          toolMsgByUseId.set(ev.id, msgId);
          break;
        }
        case 'tool_result': {
          const msgId = toolMsgByUseId.get(ev.id);
          if (msgId) {
            get().updateMessage(msgId, (m) =>
              m.tool
                ? {
                    ...m,
                    tool: {
                      ...m.tool,
                      status: ev.isError ? 'error' as const : 'ok' as const,
                      durationMs: ev.durationMs,
                      preview: previewOutput(ev.output, 160),
                      output: previewOutput(ev.output, MAX_TOOL_OUTPUT),
                    },
                  }
                : m,
            );
          }
          break;
        }
        case 'turn_end': {
          const s = get();
          if (ev.usage) {
            set({
              usage: {
                inputTokens: s.usage.inputTokens + ev.usage.inputTokens,
                outputTokens: s.usage.outputTokens + ev.usage.outputTokens,
                thinkingTokens: s.usage.thinkingTokens + (ev.usage.thinkingTokens ?? 0),
              },
            });
          }
          if (agentMeta.kind !== 'main') {
            const turnCount = (s.agents.find((a) => a.id === agentId)?.turns ?? 0) + 1;
            set({ agents: upsertAgent(s.agents, agentMeta, { turns: turnCount }) });
          }
          if (s.io) set({ io: undefined });
          break;
        }
        case 'notice':
          get().push({ kind: 'system', text: `↻ ${ev.text}`, agentId });
          set({ statusText: ev.text });
          break;
        case 'paused':
          get().push({
            kind: 'system',
            agentId,
            text: `⏸ agent paused (${ev.reason}) — type "continue" or add guidance to resume, ESC to stop`,
          });
          set({ status: 'paused' as RunStatus, statusText: 'paused — awaiting your input' });
          break;
        case 'resumed':
          get().push({ kind: 'system', text: '▶ resumed', agentId });
          set({ status: 'running' as RunStatus, statusText: 'resuming…' });
          break;
        case 'error':
          get().push({ kind: 'system', text: `⚠ agent error: ${ev.message}`, agentId });
          if (agentMeta.kind !== 'main') {
            set({ agents: upsertAgent(get().agents, agentMeta, { status: 'error' }) });
          }
          break;
        case 'done':
          if (get().io) set({ io: undefined });
          if (agentMeta.kind !== 'main') {
            set({
              agents: upsertAgent(get().agents, agentMeta, {
                status: ev.reason === 'error' ? 'error' : 'done',
              }),
            });
          }
          if (ev.reason === 'max_turns') {
            get().push({ kind: 'system', text: '⚠ investigation hit the turn limit', agentId });
          }
          break;
      }
    },
  };
}));

export type ScanStore = typeof scanStore;
