/**
 * Shell-style prompt history, persisted across sessions. Submitted prompts are
 * appended to `~/.config/leak-inspector/history.jsonl` (one JSON-encoded string
 * per line) so `↑/↓` can recall them — including after the TUI is relaunched.
 * Mirrors the XDG path convention in `preferences.ts`. Never throws on I/O.
 *
 * `historyStep` is the pure cursor for `↑/↓`: `index === -1` is the live draft
 * the user is typing; older entries are recalled newest-first and the draft is
 * restored when stepping forward past the newest entry.
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

/** Keep the on-disk log bounded; only the most recent entries are recallable. */
export const MAX_HISTORY = 200;

function historyPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'leak-inspector', 'history.jsonl');
}

/** Read history oldest→newest (cap to the last `MAX_HISTORY`). Returns [] on any error. */
export function loadHistory(): string[] {
  try {
    const path = historyPath();
    if (!existsSync(path)) return [];
    const entries: string[] = [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line);
        if (typeof v === 'string' && v.length > 0) entries.push(v);
      } catch {
        /* skip a corrupt line */
      }
    }
    return entries.slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

/**
 * Append `entry` and return the new in-memory list (oldest→newest). Blank entries
 * and consecutive duplicates are skipped; the list is capped at `MAX_HISTORY`.
 * Best-effort persistence — a write failure still returns the updated list.
 */
export function appendHistory(prev: string[], entry: string): string[] {
  const trimmed = entry.trim();
  if (!trimmed) return prev;
  if (prev[prev.length - 1] === trimmed) return prev;
  const next = [...prev, trimmed].slice(-MAX_HISTORY);
  try {
    const path = historyPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  } catch {
    /* keep the in-memory list even if persistence failed */
  }
  return next;
}

/**
 * Move through history. `index === -1` is the live `draft`; entries are indexed
 * oldest→newest, so the newest is `entries.length - 1`.
 * - `prev` (↑): from the draft jump to the newest entry, then step toward older
 *   (clamped at the oldest).
 * - `next` (↓): step toward newer; past the newest returns to the live draft.
 *   At the draft `next` is a no-op (lets other ↓ handlers act).
 */
export function historyStep(
  entries: string[],
  index: number,
  draft: string,
  dir: 'prev' | 'next',
): { index: number; value: string } {
  if (entries.length === 0) return { index: -1, value: draft };
  let nextIndex: number;
  if (dir === 'prev') {
    nextIndex = index === -1 ? entries.length - 1 : Math.max(0, index - 1);
  } else {
    if (index === -1) return { index: -1, value: draft };
    nextIndex = index + 1 > entries.length - 1 ? -1 : index + 1;
  }
  return { index: nextIndex, value: nextIndex === -1 ? draft : entries[nextIndex]! };
}
