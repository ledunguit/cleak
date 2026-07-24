import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { CommandSuggestions } from './CommandSuggestions';
import type { CommandSpec } from '../commands';

export interface SuggestionListHandle {
  navigate: (delta: 1 | -1) => void;
  selectedIndex: number;
}

export const SuggestionList = forwardRef<
  SuggestionListHandle,
  { commands: CommandSpec[]; showSuggest: boolean }
>(function SuggestionList({ commands, showSuggest }, ref) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset selection when the suggestion list changes (length) or becomes hidden
  useEffect(() => {
    setSelectedIndex(0);
  }, [commands.length, showSuggest]);

  useImperativeHandle(
    ref,
    () => ({
      navigate(delta: 1 | -1) {
        setSelectedIndex((prev) => {
          const len = commands.length;
          if (len === 0) return 0;
          const next = prev + delta;
          if (next < 0) return len - 1;
          if (next >= len) return 0;
          return next;
        });
      },
      selectedIndex,
    }),
    [commands.length, selectedIndex],
  );

  if (commands.length === 0) return null;

  const clampedIndex = Math.min(selectedIndex, Math.max(0, commands.length - 1));

  return <CommandSuggestions commands={commands} index={clampedIndex} />;
});
