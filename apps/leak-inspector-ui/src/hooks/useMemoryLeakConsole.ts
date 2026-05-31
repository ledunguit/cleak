import { useDeferredValue, useEffect, useMemo, useRef } from 'react';
import { TERMINAL_STATES, useMemoryLeakConsoleStore } from '@/stores/memoryLeakConsoleStore';
import { fetchScanEvents } from '@/services/memoryLeakApi';
import type { ScanEvent } from '@/types';

function formatEvent(event: ScanEvent): string[] {
  if (event.data) {
    return [JSON.stringify(event.data, null, 2)];
  }
  return [JSON.stringify(event)];
}

export function useMemoryLeakConsole() {
  const store = useMemoryLeakConsoleStore();
  const terminalRef = useRef<HTMLDivElement>(null);
  const deferredEvents = useDeferredValue(store.events);

  useEffect(() => {
    store.initialize();
  }, []);

  useEffect(() => {
    const scanId = store.selectedScan?.scanId;
    if (!scanId || TERMINAL_STATES.includes(store.selectedScan!.status)) {
      return undefined;
    }

    // SSE for real-time events
    const eventSource = new EventSource(`/api/scans/${scanId}/events`);
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    eventSource.onmessage = (message) => {
      try {
        store.handleStreamEvent(JSON.parse(message.data));
      } catch {
        // skip unparseable events
      }
    };

    eventSource.onerror = () => {
      eventSource.close();

      // Don't show error if scan already completed successfully
      const scanStatus = store.selectedScan?.status;
      if (scanStatus && TERMINAL_STATES.includes(scanStatus)) {
        return;
      }

      // Fallback: poll event history every 3 seconds
      store.showError(
        'Realtime stream disconnected. Falling back to polling for updates.',
      );
      pollTimer = setInterval(async () => {
        try {
          const data = await fetchScanEvents(scanId);
          for (const event of data.events || []) {
            await store.handleStreamEvent(event);
          }
          const currentStatus = store.selectedScan?.status;
          if (currentStatus && TERMINAL_STATES.includes(currentStatus)) {
            if (pollTimer) clearInterval(pollTimer);
          }
        } catch {
          // Polling failed, will retry on next interval
        }
      }, 3000);
    };

    return () => {
      eventSource.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [store.selectedScan?.scanId, store.selectedScan?.status]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
  }, [deferredEvents]);

  const selectedWorkspace = useMemo(
    () =>
      store.workspaces.find(
        (workspace: any) => workspace.path === (store.customPath.trim() || store.workspacePath),
      ) || null,
    [store.customPath, store.workspacePath, store.workspaces],
  );

  const lastEvent = deferredEvents.length ? deferredEvents[deferredEvents.length - 1] : null;
  const activeScan = store.selectedScan && !TERMINAL_STATES.includes(store.selectedScan.status);
  const terminalScans = useMemo(
    () => store.recentScans.filter((scan) => TERMINAL_STATES.includes(scan.status)),
    [store.recentScans],
  );

  function exportLog() {
    if (!store.selectedScan?.scanId) return;
    const lines = deferredEvents.flatMap((event) => formatEvent(event)).join('\n');
    const blob = new Blob([`${lines}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${store.selectedScan.scanId}-scan-progress.log`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return {
    ...store,
    selectedWorkspace,
    deferredEvents,
    lastEvent,
    activeScan,
    terminalScans,
    terminalRef,
    exportLog,
    formatEvent,
  };
}
