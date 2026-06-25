import { describe, expect, test } from 'bun:test';
import { TuiStore, visibleMessages } from './store';
import type { AgentMeta } from '../../orchestrator/investigation';
import type { AgentEvent } from '@cleak/agent-core';

const STATIC0: AgentMeta = { id: 'static-0', label: 'static 1/2', kind: 'static' };
const DYN: AgentMeta = { id: 'dynamic', label: 'dynamic', kind: 'dynamic' };

const thinking = (t: string): AgentEvent => ({ type: 'thinking', text: t });
const toolUse = (id: string, name = 'functionSummary'): AgentEvent => ({ type: 'tool_use', id, name, input: {}, isReadOnly: true });
const toolResult = (id: string, output: unknown): AgentEvent => ({ type: 'tool_result', id, name: 'functionSummary', output, isError: false, durationMs: 5 });

describe('per-agent tagging + registry', () => {
  test('tags messages with agentId and registers non-main agents', () => {
    const s = new TuiStore();
    s.applyAgentEvent(thinking('hmm'), STATIC0);
    s.applyAgentEvent({ type: 'assistant_text', text: 'hi' }, STATIC0);
    const st = s.getSnapshot();
    expect(st.agents).toHaveLength(1);
    expect(st.agents[0]).toMatchObject({ id: 'static-0', label: 'static 1/2', status: 'running', turns: 0 });
    expect(st.messages.every((m) => m.agentId === 'static-0')).toBe(true);
    expect(st.messages.find((m) => m.kind === 'thinking')!.collapsed).toBe(true);
  });

  test('main-flow events are not registered as selectable agents', () => {
    const s = new TuiStore();
    s.applyAgentEvent({ type: 'notice', text: 'Stage A' }); // default = main
    expect(s.getSnapshot().agents).toHaveLength(0);
    expect(s.getSnapshot().messages.some((m) => m.agentId === 'main')).toBe(true);
  });

  test('tool_result keeps a short preview + a full (capped) output; thinking/tool collapse by default', () => {
    const s = new TuiStore();
    s.applyAgentEvent(toolUse('tu1'), STATIC0);
    s.applyAgentEvent(toolResult('tu1', 'x'.repeat(5000)), STATIC0);
    const tool = s.getSnapshot().messages.find((m) => m.kind === 'tool')!;
    expect(tool.collapsed).toBe(true);
    expect(tool.tool!.preview!.length).toBe(160);
    expect(tool.tool!.output!.length).toBe(4000);
    expect(tool.tool!.status).toBe('ok');
  });

  test('turn_end increments the agent turn count; done sets status', () => {
    const s = new TuiStore();
    s.applyAgentEvent(thinking('a'), STATIC0);
    s.applyAgentEvent({ type: 'turn_end', turn: 1, usage: { inputTokens: 10, outputTokens: 5, thinkingTokens: 0 } }, STATIC0);
    expect(s.getSnapshot().agents[0].turns).toBe(1);
    s.applyAgentEvent({ type: 'done', reason: 'finalized' }, STATIC0);
    expect(s.getSnapshot().agents[0].status).toBe('done');
  });
});

describe('visibleMessages', () => {
  test('filters by viewAgentId', () => {
    const s = new TuiStore();
    s.applyAgentEvent({ type: 'notice', text: 'main line' });
    s.applyAgentEvent(thinking('static line'), STATIC0);
    const st = s.getSnapshot();
    expect(visibleMessages({ ...st, viewAgentId: 'main' }).every((m) => m.agentId === 'main')).toBe(true);
    expect(visibleMessages({ ...st, viewAgentId: 'static-0' }).map((m) => m.agentId)).toEqual(['static-0']);
  });
});

describe('agent-log navigation', () => {
  function withTwoAgents() {
    const s = new TuiStore();
    s.applyAgentEvent(thinking('s1'), STATIC0);
    s.applyAgentEvent(thinking('d1'), DYN);
    return s;
  }

  test('enter list → choose → open → back', () => {
    const s = withTwoAgents();
    expect(s.getSnapshot().agents.map((a) => a.id)).toEqual(['static-0', 'dynamic']);
    s.enterAgentList();
    expect(s.getSnapshot().navMode).toBe('agentlist');
    s.navMove(1);
    expect(s.getSnapshot().navIndex).toBe(1);
    s.openFocusedAgent();
    expect(s.getSnapshot().viewAgentId).toBe('dynamic');
    expect(s.getSnapshot().navMode).toBe('agentlog');
    expect(s.getSnapshot().focusMsgId).toBeDefined();
    s.backToMain();
    expect(s.getSnapshot()).toMatchObject({ viewAgentId: 'main', navMode: 'normal', focusMsgId: undefined });
  });

  test('moving the list cursor above the top returns to the main flow', () => {
    const s = withTwoAgents();
    s.enterAgentList();
    s.navMove(-1);
    expect(s.getSnapshot().navMode).toBe('normal');
  });

  test('logFocusMove moves the focus cursor; toggleFocusedCollapse flips collapse', () => {
    const s = new TuiStore();
    s.applyAgentEvent(thinking('t1'), STATIC0);
    s.applyAgentEvent(thinking('t2'), STATIC0);
    s.enterAgentList();
    s.openFocusedAgent(); // view static-0, focus first
    const first = s.getSnapshot().focusMsgId;
    s.logFocusMove(1, 24);
    const second = s.getSnapshot().focusMsgId;
    expect(second).not.toBe(first);

    const collapsedBefore = visibleMessages(s.getSnapshot()).find((m) => m.id === second)!.collapsed;
    s.toggleFocusedCollapse();
    const collapsedAfter = visibleMessages(s.getSnapshot()).find((m) => m.id === second)!.collapsed;
    expect(collapsedAfter).toBe(!collapsedBefore);
  });
});
