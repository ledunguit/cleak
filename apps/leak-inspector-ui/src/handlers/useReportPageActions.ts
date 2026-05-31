import { useNavigate, useParams } from 'react-router-dom';
import { useConsoleContext } from '@/layouts/AppLayout';

export function useReportPageActions() {
  const navigate = useNavigate();
  const { scanId } = useParams<{ scanId: string }>();
  const consoleState = useConsoleContext();
  const activeScanId = scanId || consoleState.selectedScan?.scanId;

  return {
    consoleState,
    handleReloadStructured: () =>
      activeScanId
        ? consoleState.loadStructuredReport(activeScanId).catch(() => undefined)
        : undefined,
    handleLoadReport: (format: string) =>
      activeScanId
        ? consoleState.loadReport(activeScanId, format).catch(() => undefined)
        : undefined,
    handleOpenHtml: () =>
      activeScanId
        ? window.open(`/api/scans/${activeScanId}/report?format=html`, '_blank', 'noopener,noreferrer')
        : undefined,
    handleOpenPdf: () =>
      activeScanId
        ? window.open(`/api/scans/${activeScanId}/report?format=pdf`, '_blank', 'noopener,noreferrer')
        : undefined,
    handleOpenActivity: () => navigate(activeScanId ? `/activity/${activeScanId}` : '/activity'),
  };
}
