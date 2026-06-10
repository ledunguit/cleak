import { useSyncExternalStore } from 'react';
import type { TuiStore, UiState } from '../store';

export function useStore(store: TuiStore): UiState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
