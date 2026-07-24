import { useEffect, useState, type ReactNode } from 'react';
import { TerminalSizeContext, type TerminalSize } from '../hooks/useTerminalSize';

/**
 * Centralised terminal-size provider. Subscribes to process.stdout 'resize'
 * once and propagates { columns, rows } via React context.
 *
 * The setSize guard (prev === next) ensures consumers only re-render when
 * dimensions actually change — unlike Ink's useStdout() which triggers on
 * every resize event regardless.
 */
export function TerminalSizeProvider({ children }: { children: ReactNode }) {
  const [size, setSize] = useState<TerminalSize>(() => ({
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  }));

  useEffect(() => {
    const update = () => {
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      setSize((prev) => {
        if (prev.columns === cols && prev.rows === rows) return prev;
        return { columns: cols, rows };
      });
    };
    process.stdout.on('resize', update);
    return () => {
      process.stdout.off('resize', update);
    };
  }, []);

  return (
    <TerminalSizeContext.Provider value={size}>
      {children}
    </TerminalSizeContext.Provider>
  );
}
