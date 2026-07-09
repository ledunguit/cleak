/**
 * Scan sub-store — message timeline, phase tracking, scan lifecycle, agent
 * event ingestion. Houses the hot-path `applyAgentEvent` with targeted
 * `updateMessage(id, updater)` instead of a full-array clone for tool_result.
 */

import type { AgentEvent } from '@cleak/agent-core';
import { EVENT_KIND, EVENT_PHASE, type ScanEventName } from '@cleak/common/flow/scan-flow-contract';
import type { ScanEvent } from '../../../orchestrator/events';
import type { AgentMeta } from '../../../orchestrator/investigation';
import { toolSource } from '../../../domain/mcpToolPlan';
import type { StoreAccess, UiState, UiMessage, AgentInfo } from './types';
import { phaseLabel, displayToolName, shortName, summarizeInput, previewOutput, initialPhases } from './scan-helpers';

const MAX_HISTORY = 2000;
const MAX_TOOL_OUTPUT = 4000;
const MAIN_AGENT: AgentMeta = { id: 'main', label: 'main', kind: 'main' };

export class ScanStore {
  private idSeq = 0;
  private abortController?: AbortController;
  private steeringQueue: string[] = [];
  private resumeResolver?: (decision: 'resume' | 'abort') => void;
  private toolMsgByUseId = new Map<string, string>();

  constructor(private access: StoreAccess) {}

  private nextId(prefix: string): string { return `${prefix}_${this.idSeq++}`; }

  push(msg: Omit<UiMessage, 'id' | 'agentId'> & { agentId?: string }): string {
    const { get, set } = this.access;
    const id = this.nextId(msg.kind);
    const agentId = msg.agentId ?? 'main';
    let messages = [...get().messages, { id, ...msg, agentId }];
    let scrollOffset = get().scrollOffset;
    if (messages.length > MAX_HISTORY) {
      const dropped = messages.length - MAX_HISTORY;
      messages = messages.slice(dropped);
      scrollOffset = Math.max(0, scrollOffset - dropped);
    }
    if (scrollOffset > 0 && agentId === get().viewAgentId) scrollOffset += 1;
    set({ messages, scrollOffset });
    return id;
  }
  updateMessage(id: string, updater: (m: UiMessage) => UiMessage): void {
    const { get, set } = this.access;
    const msgs = get().messages;
    const idx = msgs.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const next = msgs.slice();
    next[idx] = updater(next[idx]);
    set({ messages: next });
  }
  scrollBy(delta: number, maxOffset: number): void {
    const s = this.access.get();
    const next = Math.max(0, Math.min(maxOffset, s.scrollOffset + delta));
    if (next !== s.scrollOffset) this.access.set({ scrollOffset: next });
  }
  scrollToBottom(): void { if (this.access.get().scrollOffset !== 0) this.access.set({ scrollOffset: 0 }); }

  addUserMessage(text: string): void { this.push({ kind: 'user', text }); }
  addSystemMessage(text: string, color?: string): void { this.push({ kind: 'system', text, ...(color ? { color } : {}) }); }
  setIo(io: UiState['io']): void { if (io !== this.access.get().io) this.access.set({ io }); }
  private upsertAgent(agent: AgentMeta, patch?: Partial<AgentInfo>): void {
    const s = this.access.get();
    const existing = s.agents.find((a) => a.id === agent.id);
    if (!existing) {
      this.access.set({ agents: [...s.agents, { id: agent.id, label: agent.label, kind: agent.kind, status: 'running', turns: 0, ...patch }] });
    } else if (patch) {
      this.access.set({ agents: s.agents.map((a) => (a.id === agent.id ? { ...a, ...patch } : a)) });
    }
  }
  setAbortController(ac: AbortController | undefined): void { this.abortController = ac; }
  abort(): void {
    if (this.resumeResolver) {
      const resolve = this.resumeResolver; this.resumeResolver = undefined;
      this.push({ kind: 'system', text: '⎋ stopping…' });
      this.access.set({ statusText: 'stopping…' });
      resolve('abort'); return;
    }
    const s = this.access.get();
    if (s.status !== 'running' || !this.abortController) return;
    this.abortController.abort();
    this.push({ kind: 'system', text: '⎋ interrupting…' });
    this.access.set({ statusText: 'interrupting…' });
  }
  awaitResume(): Promise<'resume' | 'abort'> { return new Promise((resolve) => { this.resumeResolver = resolve; }); }
  resume(): void {
    const s = this.access.get();
    if (s.status !== 'paused' || !this.resumeResolver) return;
    const resolve = this.resumeResolver; this.resumeResolver = undefined;
    this.access.set({ status: 'running', statusText: 'resuming…' }); resolve('resume');
  }
  isPaused(): boolean { return this.access.get().status === 'paused'; }
  isRunning(): boolean { return this.access.get().status === 'running'; }
  enqueueSteering(text: string): void { this.steeringQueue.push(text); }
  drainSteering(): string[] {
    if (this.steeringQueue.length === 0) return [];
    const out = this.steeringQueue; this.steeringQueue = []; return out;
  }
  beginRun(scanId: string, mode: UiState['mode']): void {
    this.steeringQueue = []; this.resumeResolver = undefined;
    if (this.access.get().messages.length > 0) this.push({ kind: 'phase', text: '── new scan ──' });
    this.access.set({
      status: 'running', statusText: 'starting…', scanId, mode,
      phases: initialPhases(), summary: undefined, reportDir: undefined,
      currentPhase: undefined, io: undefined,
      usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
      ranDynamicTool: false, scrollOffset: 0, agents: [],
      viewAgentId: 'main', navMode: 'normal', navIndex: 0, focusMsgId: undefined,
      startedAt: Date.now(),
    });
  }

  finishRun(reportDir: string, summary: UiState['summary']): void {
    const s = this.access.get();
    if (s.dynamic !== 'off' && !s.ranDynamicTool) {
      this.push({ kind: 'system', text: '⚠ dynamic was enabled but the agent ran no dynamic tools — the model judged static evidence sufficient (selective). Use /config or /dynamic → aggressive to force a run.' });
    }
    this.access.set({ status: 'done', statusText: 'done', reportDir, summary, io: undefined });
  }
  failRun(message: string): void {
    this.push({ kind: 'system', text: `✗ ${message}` }); this.access.set({ status: 'error', statusText: 'error' });
  }
  applyScanEvent(ev: ScanEvent): void {
    if (ev.data?.warning) this.push({ kind: 'system', text: `⚠ ${String(ev.data.warning)}` });
    if (ev.data?.detectedAnalyzerRoot)
      this.push({ kind: 'system', text: `↳ mapped repo to analyzer root ${String(ev.data.detectedAnalyzerRoot)}` });
    const phase = EVENT_PHASE[ev.name as ScanEventName] ?? ev.phase;
    const kind = EVENT_KIND[ev.name as ScanEventName];
    if (!phase) return;
    const phases = { ...this.access.get().phases };
    if (kind === 'phase_start') {
      phases[phase] = 'active'; this.access.set({ phases, currentPhase: phase, statusText: phase });
      this.push({ kind: 'phase', text: phaseLabel(phase) });
    } else if (kind === 'phase_finish') {
      phases[phase] = 'done'; this.access.set({ phases });
    } else if (kind === 'terminal') {
      phases[phase] = ev.name.toString().includes('fail') ? 'failed' : 'done'; this.access.set({ phases });
    } else {
      this.access.set({ statusText: `${phase}: ${shortName(ev.name)}` });
    }
  }

  // ── AgentEvent stream → assistant text + tool cards ──
  applyAgentEvent(ev: AgentEvent, agent: AgentMeta = MAIN_AGENT): void {
    const agentId = agent.id;
    if (agent.kind !== 'main') this.upsertAgent(agent);
    switch (ev.type) {
      case 'thinking':
        if (ev.text?.trim()) this.push({ kind: 'thinking', text: ev.text.trim(), agentId, collapsed: true });
        break;
      case 'assistant_text':
        if (ev.text?.trim()) this.push({ kind: 'assistant', text: ev.text.trim(), agentId });
        break;
      case 'tool_use': {
        if (this.access.get().io) this.access.set({ io: undefined });
        if (toolSource(ev.name) === 'mcp-dynamic' && !this.access.get().ranDynamicTool) this.access.set({ ranDynamicTool: true });
        const title = `${displayToolName(ev.name)}${summarizeInput(ev.input)}`;
        const msgId = this.push({ kind: 'tool', agentId, collapsed: true, tool: { name: ev.name, title, source: toolSource(ev.name), status: 'running' } });
        this.toolMsgByUseId.set(ev.id, msgId);
        break;
      }
      case 'tool_result': {
        const msgId = this.toolMsgByUseId.get(ev.id);
        if (msgId) this.updateMessage(msgId, (m) => m.tool
          ? { ...m, tool: { ...m.tool, status: ev.isError ? 'error' as const : 'ok' as const, durationMs: ev.durationMs, preview: previewOutput(ev.output, 160), output: previewOutput(ev.output, MAX_TOOL_OUTPUT) } }
          : m);
        break;
      }
      case 'turn_end': {
        const s = this.access.get();
        if (ev.usage) this.access.set({ usage: { inputTokens: s.usage.inputTokens + ev.usage.inputTokens, outputTokens: s.usage.outputTokens + ev.usage.outputTokens, thinkingTokens: s.usage.thinkingTokens + (ev.usage.thinkingTokens ?? 0) } });
        if (agent.kind !== 'main') this.upsertAgent(agent, { turns: (s.agents.find((a) => a.id === agentId)?.turns ?? 0) + 1 });
        if (s.io) this.access.set({ io: undefined });
        break;
      }
      case 'notice':
        this.push({ kind: 'system', text: `↻ ${ev.text}`, agentId }); this.access.set({ statusText: ev.text }); break;
      case 'paused':
        this.push({ kind: 'system', agentId, text: `⏸ agent paused (${ev.reason}) — type "continue" or add guidance to resume, ESC to stop` });
        this.access.set({ status: 'paused', statusText: 'paused — awaiting your input' }); break;
      case 'resumed':
        this.push({ kind: 'system', text: '▶ resumed', agentId }); this.access.set({ status: 'running', statusText: 'resuming…' }); break;
      case 'error':
        this.push({ kind: 'system', text: `⚠ agent error: ${ev.message}`, agentId });
        if (agent.kind !== 'main') this.upsertAgent(agent, { status: 'error' }); break;
      case 'done':
        if (this.access.get().io) this.access.set({ io: undefined });
        if (agent.kind !== 'main') this.upsertAgent(agent, { status: ev.reason === 'error' ? 'error' : 'done' });
        if (ev.reason === 'max_turns') this.push({ kind: 'system', text: '⚠ investigation hit the turn limit', agentId });
        break;
    }
  }
}
