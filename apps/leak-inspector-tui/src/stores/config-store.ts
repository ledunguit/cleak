/**
 * Config sub-store (Zustand) — LLM options, permission mode toggle, auto-show-report,
 * and pending permission requests.
 *
 * Cross-store call (addSystemMessage) is injected via setPushSystem callback
 * to avoid circular imports between config-store.ts and scan-store.ts.
 *
 * Migration note: converted from surfaces/tui/store/config-store.ts class.
 */

import { createStore } from 'zustand/vanilla';
import { devtools, subscribeWithSelector } from 'zustand/middleware';
import type { PendingPermission } from './types';
import type { RunConfig } from '@cleak/config';

// ─── State & Actions interfaces ──────────────────────────────────────────────

export interface ConfigState {
  mode: 'no_llm' | 'llm_assisted';
  dynamic: 'off' | 'selective' | 'aggressive';
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  autoShowReport: boolean;
  fullscreen: boolean;
  sidebarPosition: 'left' | 'right';
  permissionMode: 'ask' | 'auto';
  pendingPermission?: PendingPermission;
}

export interface ConfigActions {
  setOptions: (
    opts: Partial<Pick<ConfigState, 'mode' | 'dynamic' | 'provider' | 'model' | 'baseUrl' | 'apiKey'>>,
  ) => void;
  setAutoShowReport: (auto: boolean) => void;
  setFullscreen: (fullscreen: boolean) => void;
  setSidebarPosition: (pos: 'left' | 'right') => void;
  seedFromConfig: (cfg: RunConfig) => void;
  cyclePermissionMode: () => 'ask' | 'auto';
  requestPermission: (req: { id: string; name: string; input: unknown }) => Promise<'allow' | 'deny'>;
  resolvePermission: (decision: 'allow' | 'deny') => void;
  /** Inject cross-store callback for pushSystem. Called from adapter during setup. */
  setPushSystem: (fn: (text: string, color?: string) => void) => void;
}

// ─── Store creation ──────────────────────────────────────────────────────────

export const configStore = createStore<ConfigState & ConfigActions>()(
  devtools(
    subscribeWithSelector((set, get) => {
  // Cross-store callback — set by adapter after creation
  let pushSystem: (text: string, color?: string) => void = () => {};

  return {
    // ─── Initial state ────────────────────────────────────────────────
    mode: 'llm_assisted' as const,
    dynamic: 'off' as const,
    provider: 'local',
    model: '',
    autoShowReport: false,
    fullscreen: false,
    sidebarPosition: 'right' as const,
    permissionMode: 'ask' as const,

    // ─── Actions ──────────────────────────────────────────────────────

    setOptions: (opts) => set(opts),

    setAutoShowReport: (autoShowReport) => set({ autoShowReport }),

    setFullscreen: (fullscreen) => set({ fullscreen }),

    setSidebarPosition: (sidebarPosition) => set({ sidebarPosition }),

    seedFromConfig: (cfg) => set({
      provider: cfg.provider,
      model: cfg.llm.model,
      baseUrl: cfg.llm.baseUrl,
      apiKey: cfg.llm.apiKey,
    }),

    setPushSystem: (fn) => {
      pushSystem = fn;
    },

    cyclePermissionMode: () => {
      const s = get();
      const next = s.permissionMode === 'auto' ? 'ask' : 'auto';
      set({ permissionMode: next });
      if (next === 'auto' && s.pendingPermission) get().resolvePermission('allow');
      pushSystem(
        next === 'auto'
          ? '⏵ auto-accept ON — tools run without asking · shift+tab to turn off'
          : 'auto-accept OFF — tools will ask before running',
        next === 'auto' ? '#C084FC' : undefined,
      );
      return next;
    },

    requestPermission: (req) => {
      const s = get();
      if (s.permissionMode === 'auto') return Promise.resolve('allow');
      return new Promise((resolve) => {
        set({
          pendingPermission: {
            ...req,
            resolve: (decision) => {
              set({ pendingPermission: undefined });
              resolve(decision);
            },
          },
        });
      });
    },

    resolvePermission: (decision) => {
      get().pendingPermission?.resolve(decision);
    },
  };
}),
    { name: 'cleak-config', enabled: process.env.NODE_ENV !== 'production' },
  ),
);

export type ConfigStore = typeof configStore;
