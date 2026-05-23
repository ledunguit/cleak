import { useEffect } from 'react';
import { useParams } from 'react-router-dom';

import { ReportControlsCard } from '@/components/ReportControlsCard';
import { useReportPageActions } from '@/handlers/useReportPageActions';

export function ReportPage() {
  const { scanId } = useParams<{ scanId: string }>();
  const { consoleState, handleReloadStructured, handleLoadReport, handleOpenHtml } = useReportPageActions();
  const selectedScanId = consoleState.selectedScan?.scanId;

  useEffect(() => {
    if (!scanId || selectedScanId === scanId) {
      return;
    }
    (consoleState as any).ensureScanLoaded(scanId).catch(() => undefined);
  }, [scanId, selectedScanId]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <ReportControlsCard
        selectedScan={consoleState.selectedScan}
        reportData={consoleState.reportData}
        reportText={consoleState.reportText}
        onReloadStructured={handleReloadStructured}
        onLoadReport={handleLoadReport}
        onOpenHtml={handleOpenHtml}
      />
    </div>
  );
}
