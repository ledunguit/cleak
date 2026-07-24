/**
 * Zustand stores index.
 * Each store is created with `createStore` from zustand/vanilla.
 * Re-exported here for convenient imports.
 *
 * Also provides backward-compatible 1-arg wrappers for `visibleMessages`
 * and `visibleFindings` that take the full UiState (matching the old
 * store.ts API) — used by components that have not yet migrated to the
 * raw (messages, viewAgentId) or (FindingsUiState) signatures.
 */

import type { FindingView } from '../surfaces/tui/findings/findingView';
import type { UiState, UiMessage } from './types';
import { visibleFindings as _visibleFindings } from './findings-store';

// ── Navigation store ──

export {
  navigationStore,
} from './navigation-store';
export type {
  NavState,
  NavActions,
  NavigationStore,
} from './navigation-store';

// ── Scan store ──

export {
  scanStore,
} from './scan-store';
export type {
  ScanState,
  ScanActions,
  ScanStore as ScanStoreType,
} from './scan-store';

// ── Config store ──

export {
  configStore,
} from './config-store';
export type {
  ConfigState,
  ConfigActions,
  ConfigStore,
} from './config-store';

// ── Eval store ──

export {
  evalStore,
} from './eval-store';
export type {
  EvalState,
  EvalActions,
  EvalStore,
} from './eval-store';

// ── Findings store ──

export {
  findingsStore,
} from './findings-store';
export type {
  FindingsState,
  FindingsActions,
  FindingsStore,
} from './findings-store';

// ── Types ──

export type * from './types';

// ── TuiStore re-export (backward compat — class defined in surfaces/tui/store.ts) ──

export { TuiStore } from '../surfaces/tui/store';

// ── 1-arg UiState wrappers (backward compat — match old store.ts API) ──

/**
 * Filter messages by the active agent (takes full UiState).
 * Compat wrapper; prefer the 2-arg `visibleMessages(messages, viewAgentId)`
 * from navigation-store for new code.
 */
export function visibleMessages(state: UiState): UiMessage[] {
  return state.messages.filter((m) => m.agentId === state.viewAgentId);
}

/**
 * Sort + filter findings (takes full UiState).
 * Compat wrapper; prefer `visibleFindings(FindingsUiState)` from
 * findings-store for new code.
 */
export function visibleFindings(state: UiState): FindingView[] {
  if (!state.findings) return [];
  return _visibleFindings(state.findings);
}
