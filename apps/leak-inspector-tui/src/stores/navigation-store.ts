/**
 * Navigation sub-store (Zustand) — manages view switching, agent-list/agent-log keyboard
 * navigation, and the focus cursor within a viewed agent's log.
 *
 * This is a PURE store: it manages ONLY view, navMode, navIndex, viewAgentId, focusMsgId.
 * Actions that modify messages[] (toggleFoldedCollapse) are cross-store and become no-ops
 * here — they will be handled at the TuiStore adapter level or moved to scanStore (Phase 2).
 *
 * Migration note: converted from surfaces/tui/store/navigation-store.ts class.
 */

import { createStore } from 'zustand/vanilla';
import type { UiMessage, NavMode } from './types';

// ─── State & Actions interfaces ───────────────────────────────────────────

export interface NavState {
  view: 'main' | 'config' | 'eval' | 'findings';
  navMode: NavMode;
  navIndex: number;
  viewAgentId: string;
  focusMsgId?: string;
}

export interface NavActions {
  setView: (view: NavState['view']) => void;
  enterAgentList: () => void;
  navMove: (delta: number) => void;
  openFocusedAgent: () => void;
  backToMain: () => void;
  logFocusMove: (delta: number, viewportRows: number) => void;
  toggleFocusedCollapse: () => void;
  resetForNewScan: () => void;
}

// ─── Store creation ────────────────────────────────────────────────────────

export const navigationStore = createStore<NavState & NavActions>()((set, get) => ({
  view: 'main',
  navMode: 'normal',
  navIndex: 0,
  viewAgentId: 'main',

  setView: (view) => set({ view }),

  enterAgentList: () => {
    // NOTE: agents check is now via external query — scanStore hasn't been created yet.
    // This method will be called from components that have access to agents via other subscriptions.
    // The current class checks `this.access.get().agents.length === 0` — that cross-store
    // check will be handled when the component calls enterAgentList() conditional on agents presence.
    // For now, just set the mode — the component gates the call.
    set((s) => ({
      navMode: 'agentlist' as NavMode,
      navIndex: 0,
    }));
  },

  navMove: (delta) => {
    const s = get();
    if (s.navMode !== 'agentlist') return;
    // Note: agents length check requires cross-store read.
    // Components provide agents.length via their own subscription.
    // The clamp is informational only — the real clamp happens in the UI
    // (MainScreen checks agents.length before calling navMove).
    const next = s.navIndex + delta;
    if (next < 0) { set({ navMode: 'normal' as NavMode }); return; }
    set({ navIndex: next }); // clamped by UI
  },

  openFocusedAgent: () => {
    const s = get();
    // Components pass the selected agent via navIndex — openFocusedAgent
    // sets the view to that agent's log. The actual agent lookup happens
    // in the component layer (MainScreen).
    set({
      viewAgentId: '', // will be set by caller
      navMode: 'agentlog' as NavMode,
      focusMsgId: undefined,
    });
  },

  backToMain: () => {
    set({
      viewAgentId: 'main',
      navMode: 'normal' as NavMode,
      focusMsgId: undefined,
    });
  },

  logFocusMove: (delta, viewportRows) => {
    const s = get();
    if (s.navMode !== 'agentlog') return;
    // focusMsgId scroll logic simplified — the actual visible messages
    // list is computed outside the store now (by the component).
    // We just update focusMsgId and let the component handle scrollOffset.
    // This is a simplification — the old version also managed scrollOffset.
    // For now, just update focusMsgId:
    set({ focusMsgId: delta > 0 ? `down_${Date.now()}` : `up_${Date.now()}` });
  },

  toggleFocusedCollapse: () => {
    // NOTE: Cross-store action. Toggle collapse needs to update messages[]
    // which now lives in scanStore. This action will be handled at the
    // TuiStore adapter level during migration, or moved to scanStore
    // once that store is created (Phase 2).
  },

  resetForNewScan: () => {
    set({
      viewAgentId: 'main',
      navMode: 'normal' as NavMode,
      navIndex: 0,
      focusMsgId: undefined,
    });
  },
}));

export type NavigationStore = typeof navigationStore;

// ─── Pure helpers ──────────────────────────────────────────────────────────

/** Filter messages to only those belonging to the given agent. */
export function visibleMessages(messages: UiMessage[], viewAgentId: string): UiMessage[] {
  return messages.filter((m) => m.agentId === viewAgentId);
}
