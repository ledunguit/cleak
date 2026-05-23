import { useNavigate } from 'react-router-dom';
import { useConsoleContext } from '@/layouts/AppLayout';
import { describeEvent } from '@/utils/ui';
import type { ScanSummary } from '@/types';

export function useActivityPageActions() {
  const navigate = useNavigate();
  const consoleState = useConsoleContext();

  async function handleSelectScan(scan: ScanSummary) {
    const result = await consoleState.openScan(scan.scanId, scan);
    if (result) {
      navigate(`/activity/${scan.scanId}`);
    }
  }

  return {
    consoleState,
    handleSelectScan,
    handleRefreshHistory: () => consoleState.loadRecentScans().catch(() => undefined),
    handleCancelScan: () => consoleState.cancelScan(),
    handleRequestDeleteScan: (scan: ScanSummary) => consoleState.requestDeleteScan(scan),
    handleRequestDeleteTerminalScans: () => consoleState.requestDeleteTerminalScans(),
    handleCloseDeleteDialog: () => consoleState.closeDeleteDialog(),
    handleConfirmDeleteDialog: () => consoleState.confirmDeleteDialog(),
    handleOpenReport: () =>
      navigate(
        consoleState.selectedScan?.scanId
          ? `/report/${consoleState.selectedScan.scanId}`
          : '/report',
      ),
    handleReloadLog: () =>
      consoleState.selectedScan
        ? consoleState.loadEventHistory(consoleState.selectedScan.scanId).catch(() => undefined)
        : undefined,
    handleReloadStructured: () =>
      consoleState.selectedScan
        ? consoleState.loadStructuredReport(consoleState.selectedScan.scanId).catch(() => undefined)
        : undefined,
    handleLoadReport: (format: string) =>
      consoleState.selectedScan
        ? consoleState.loadReport(consoleState.selectedScan.scanId, format).catch(() => undefined)
        : undefined,
    handleOpenHtml: () =>
      consoleState.selectedScan
        ? window.open(
            `/api/scans/${consoleState.selectedScan.scanId}/report?format=html`,
            '_blank',
            'noopener,noreferrer',
          )
        : undefined,
    handleExportLog: () => (consoleState as any).exportLog?.(),
    formatEvent: describeEvent,
  };
}
