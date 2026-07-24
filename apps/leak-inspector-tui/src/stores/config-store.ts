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
import { devtools, subscribeWithSelector, persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { PendingPermission } from './types';

// ─── State & Actions interfaces ──────────────────────────────────────────────

export interface ConfigState {
  mode: 'no_llm' | 'llm_assisted';
  dynamic: 'off' | 'selective' | 'aggressive';
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  autoShowReport: boolean;
  permissionMode: 'ask' | 'auto';
  pendingPermission?: PendingPermission;
}

export interface ConfigActions {
  setOptions: (
    opts: Partial<Pick<ConfigState, 'mode' | 'dynamic' | 'provider' | 'model' | 'baseUrl' | 'apiKey'>>,
  ) => void;
  setAutoShowReport: (auto: boolean) => void;
  cyclePermissionMode: () => 'ask' | 'auto';
  requestPermission: (req: { id: string; name: string; input: unknown }) => Promise<'allow' | 'deny'>;
  resolvePermission: (decision: 'allow' | 'deny') => void;
  /** Inject cross-store callback for pushSystem. Called from adapter during setup. */
  setPushSystem: (fn: (text: string, color?: string) => void) => void;
}

// ─── Filesystem storage adapter for persist middleware ────────────────────────

const configDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'cleak');
const configPath = join(configDir, 'config.json');

const fsStorage: StateStorage = {
  getItem: (name) => {
    try { return readFileSync(name, 'utf-8'); } catch { return null; }
  },
  setItem: (name, value) => {
    const dir = name.slice(0, name.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(name, value, 'utf-8');
  },
  removeItem: () => {},
};

// ─── Store creation ──────────────────────────────────────────────────────────

export const configStore = createStore<ConfigState & ConfigActions>()(
  persist(
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
    permissionMode: 'ask' as const,

    // ─── Actions ──────────────────────────────────────────────────────

    setOptions: (opts) => set(opts),

    setAutoShowReport: (autoShowReport) => set({ autoShowReport }),

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
  {
    name: configPath,
    storage: createJSONStorage(() => fsStorage),
    partialize: (state) => ({
      mode: state.mode,
      dynamic: state.dynamic,
      provider: state.provider,
      model: state.model,
      baseUrl: state.baseUrl,
      apiKey: state.apiKey,
      autoShowReport: state.autoShowReport,
      permissionMode: state.permissionMode,
    }),
  },
));

export type ConfigStore = typeof configStore;
