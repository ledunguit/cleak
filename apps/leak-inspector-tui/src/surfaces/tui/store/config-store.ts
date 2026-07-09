/**
 * Config sub-store — LLM options, permission mode toggle, auto-show-report.
 * Cross-store call (addSystemMessage) is injected via callback.
 */

import type { StoreAccess, UiState, PendingPermission } from './types';

export class ConfigStore {
  constructor(
    private access: StoreAccess,
    private pushSystem: (text: string, color?: string) => void,
  ) {}

  setOptions(opts: Partial<Pick<UiState, 'mode' | 'dynamic' | 'provider' | 'model' | 'baseUrl' | 'apiKey'>>): void {
    this.access.set(opts);
  }

  setAutoShowReport(autoShowReport: boolean): void {
    this.access.set({ autoShowReport });
  }

  /** Toggle Ask ↔ Auto-accept (Shift+Tab). Session-only. */
  cyclePermissionMode(): 'ask' | 'auto' {
    const s = this.access.get();
    const next = s.permissionMode === 'auto' ? 'ask' : 'auto';
    this.access.set({ permissionMode: next });
    if (next === 'auto' && s.pendingPermission) this.resolvePermission('allow');
    this.pushSystem(
      next === 'auto'
        ? '⏵ auto-accept ON — tools run without asking · shift+tab to turn off'
        : 'auto-accept OFF — tools will ask before running',
      next === 'auto' ? '#C084FC' : undefined,
    );
    return next;
  }

  requestPermission(req: { id: string; name: string; input: unknown }): Promise<'allow' | 'deny'> {
    if (this.access.get().permissionMode === 'auto') return Promise.resolve('allow');
    return new Promise((resolve) => {
      this.access.set({
        pendingPermission: {
          ...req,
          resolve: (decision) => {
            this.access.set({ pendingPermission: undefined });
            resolve(decision);
          },
        },
      });
    });
  }

  resolvePermission(decision: 'allow' | 'deny'): void {
    this.access.get().pendingPermission?.resolve(decision);
  }
}
