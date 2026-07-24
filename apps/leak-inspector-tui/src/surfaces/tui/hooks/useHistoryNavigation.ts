/**
 * Hook that owns prompt history navigation (↑/↓ recall) and slash-command
 * suggestion state, extracted so App.tsx can focus on wiring and rendering.
 *
 * Returns refs and controls the submit handler and onChange use to persist
 * history and reset the recall cursor.
 */
import { useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { matchCommands, type CommandSpec } from '../commands';
import { loadHistory, historyStep } from '../history';
import type { TuiStore } from '../../../stores';

/** Minimal overlay shape — enough to gate `showSuggest`. */
interface Overlay {
  title: string;
  options: unknown[];
  multi?: boolean;
  onSubmit: (values: string[]) => void;
}

export interface UseHistoryNavigationReturn {
  /** Mutable history list (oldest→newest); the submit handler appends to it. */
  history: MutableRefObject<string[]>;
  /** Step through history with ↑/↓ (null-safe, no-op at boundaries). */
  recallHistory: (dir: 'prev' | 'next') => void;
  /** Drop a command name into the input (Tab / first Enter on a suggestion). */
  completeCommand: (name: string) => void;
  /** Commands matching the current slash-token (empty when not in suggest mode). */
  matches: CommandSpec[];
  /** Whether the suggestion popup should render (typed `/` & no overlay). */
  showSuggest: boolean;
  /**
   * Reset the history cursor back to the live draft (called after submit and
   * when the user starts typing after recalling an entry).
   */
  resetHistoryCursor: () => void;
}

/**
 * `useHistoryNavigation(input, setInput, store, overlay, setInputRev)`
 *
 * @param input       Current input value (from useState in App).
 * @param setInput    Setter for input value.
 * @param _store      TuiStore (accepted per interface; not consumed internally).
 * @param overlay     Current overlay state (`null` when no overlay is open).
 * @param setInputRev Increment to force TextInput remount so the cursor snaps
 *                    to the end after a recall or completion.
 */
export function useHistoryNavigation(
  input: string,
  setInput: Dispatch<SetStateAction<string>>,
  _store: TuiStore,
  overlay: Overlay | null,
  setInputRev: Dispatch<SetStateAction<number>>,
): UseHistoryNavigationReturn {
  // ── Prompt history (shell-style ↑/↓, persisted across sessions) ──
  // `histIndex === -1` is the live draft; `histDraft` stashes it on the first ↑.
  const history = useRef<string[]>(loadHistory());
  const histIndex = useRef(-1);
  const histDraft = useRef('');

  const recallHistory = (dir: 'prev' | 'next'): void => {
    if (dir === 'prev' && histIndex.current === -1) histDraft.current = input;
    const r = historyStep(history.current, histIndex.current, histDraft.current, dir);
    if (r.index === histIndex.current) return; // no movement — let other handlers act
    histIndex.current = r.index;
    setInput(r.value);
    setInputRev((x) => x + 1); // snap cursor to end
  };

  const showSuggest = input.startsWith('/') && !overlay;
  const matches = showSuggest ? matchCommands(input) : [];

  const completeCommand = (name: string): void => {
    setInput(`${name} `);
    setInputRev((r) => r + 1); // snap cursor to end
  };

  const resetHistoryCursor = (): void => {
    histIndex.current = -1;
    histDraft.current = '';
  };

  return {
    history,
    recallHistory,
    completeCommand,
    matches,
    showSuggest,
    resetHistoryCursor,
  };
}
