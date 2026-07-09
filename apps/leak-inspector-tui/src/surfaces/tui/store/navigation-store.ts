/**
 * Navigation sub-store — manages view switching, agent-list/agent-log keyboard
 * navigation, and the focus cursor within a viewed agent's log.
 */

import type { StoreAccess, UiState, UiMessage } from './types';

/** Messages belonging to the currently-viewed agent (main = the 'main' flow). */
export function visibleMessages(state: UiState): UiMessage[] {
  return state.messages.filter((m) => m.agentId === state.viewAgentId);
}

export class NavigationStore {
  constructor(private access: StoreAccess) {}

  setView(view: UiState['view']): void {
    this.access.set({ view });
  }

  /** From the main flow, drop the cursor into the agent list (if any agents). */
  enterAgentList(): void {
    const s = this.access.get();
    if (s.agents.length === 0) return;
    this.access.set({ navMode: 'agentlist', navIndex: 0 });
  }

  /** Move the agent-list cursor; moving above the top exits back to the main flow. */
  navMove(delta: number): void {
    const s = this.access.get();
    if (s.navMode !== 'agentlist') return;
    const next = s.navIndex + delta;
    if (next < 0) { this.access.set({ navMode: 'normal' }); return; }
    this.access.set({ navIndex: Math.min(s.agents.length - 1, next) });
  }

  /** Open the selected agent's log (focus its first collapsible line). */
  openFocusedAgent(): void {
    const s = this.access.get();
    if (s.navMode !== 'agentlist') return;
    const agent = s.agents[s.navIndex];
    if (!agent) return;
    const first = s.messages.find((m) => m.agentId === agent.id);
    this.access.set({ viewAgentId: agent.id, navMode: 'agentlog', focusMsgId: first?.id, scrollOffset: 0 });
  }

  /** Return from an agent's log to the main flow. */
  backToMain(): void {
    this.access.set({ viewAgentId: 'main', navMode: 'normal', focusMsgId: undefined, scrollOffset: 0 });
  }

  /** Move the focus cursor within the viewed agent's log, keeping it on screen. */
  logFocusMove(delta: number, viewportRows: number): void {
    const s = this.access.get();
    if (s.navMode !== 'agentlog') return;
    const list = visibleMessages(s);
    if (list.length === 0) return;
    const cur = list.findIndex((m) => m.id === s.focusMsgId);
    const idx = Math.max(0, Math.min(list.length - 1, (cur < 0 ? list.length - 1 : cur) + delta));
    const focusMsgId = list[idx].id;
    const rows = Math.max(1, viewportRows);
    const lower = list.length - rows - idx;
    const upper = list.length - 1 - idx;
    let scrollOffset = s.scrollOffset;
    if (scrollOffset < lower) scrollOffset = lower;
    if (scrollOffset > upper) scrollOffset = upper;
    scrollOffset = Math.max(0, scrollOffset);
    this.access.set({ focusMsgId, scrollOffset });
  }

  /** Expand/collapse the focused thinking/tool line. */
  toggleFocusedCollapse(): void {
    const s = this.access.get();
    const id = s.focusMsgId;
    if (!id) return;
    const messages = s.messages.map((m) =>
      m.id === id && (m.kind === 'thinking' || m.kind === 'tool') ? { ...m, collapsed: !m.collapsed } : m,
    );
    this.access.set({ messages });
  }
}
