/**
 * Selector-based store subscriptions for the TUI.
 *
 * `useStoreSelector` wraps `useSyncExternalStore` so that components only
 * re-render when the **reference** of the selected value changes — even if
 * the underlying store fires on every patch. Return the same object/array
 * reference and the component skips the render.
 *
 * @example
 * ```ts
 * const scanId = useStoreSelector(store, s => s.scanId);
 * const messages = useStoreSelector(store, s => s.messages);
 * ```
 */

import { useSyncExternalStore } from 'react';
import type { TuiStore } from '../store';
import type { UiState } from './types';

export function useStoreSelector<T>(
  store: TuiStore,
  selector: (state: UiState) => T,
): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getSnapshot()),
    () => selector(store.getSnapshot()),
  );
}
