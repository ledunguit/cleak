import { create } from 'zustand';
import type { LogEntry, LogLevel } from '@/types';

interface LogsState {
  logs: LogEntry[];
  isPaused: boolean;
  autoScroll: boolean;
  filter: string;
  levelFilter: LogLevel;
}

interface LogsActions {
  setPaused: (v: boolean) => void;
  setAutoScroll: (v: boolean) => void;
  setFilter: (v: string) => void;
  setLevelFilter: (v: LogLevel) => void;
  clearLogs: () => void;
  appendLog: (entry: LogEntry) => void;
  loadInitialLogs: () => Promise<void>;
  filteredLogs: () => LogEntry[];
}

export const useLogsStore = create<LogsState & LogsActions>((set, get) => ({
  logs: [],
  isPaused: false,
  autoScroll: true,
  filter: '',
  levelFilter: 'ALL',

  setPaused: (isPaused) => set({ isPaused }),
  setAutoScroll: (autoScroll) => set({ autoScroll }),
  setFilter: (filter) => set({ filter }),
  setLevelFilter: (levelFilter) => set({ levelFilter }),
  clearLogs: () => set({ logs: [] }),

  appendLog: (entry) => set((state) => ({ logs: [...state.logs, entry] })),

  loadInitialLogs: async () => {
    try {
      const response = await fetch('/api/logs?limit=500');
      const data = await response.json();
      set({ logs: data.logs || [] });
    } catch {
      // silent
    }
  },

  filteredLogs: () => {
    const { logs, filter, levelFilter } = get();
    return logs.filter((log) => {
      if (levelFilter !== 'ALL' && log.level !== levelFilter) return false;
      if (filter && !log.message.toLowerCase().includes(filter.toLowerCase())) return false;
      return true;
    });
  },
}));
