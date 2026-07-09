import type { ScanReport } from '../../types';
import { escapeCsv } from './shared';

export function toCsv(report: ScanReport): string {
  const headers = 'id,function,file,line,allocation_type,verdict,confidence,explanation,repair_suggestion\n';
  const rows = report.bundles
    .filter((b) => b.verdict)
    .map((b) =>
      [
        b.bundleId,
        escapeCsv(b.candidate.function_name),
        escapeCsv(b.candidate.file_path),
        b.candidate.line_number,
        escapeCsv(b.candidate.allocation_type),
        b.verdict!.verdict,
        b.verdict!.confidence.toFixed(2),
        escapeCsv((b.verdict!.explanation || '').slice(0, 200)),
        escapeCsv((b.verdict!.repair_suggestion || '').slice(0, 200)),
      ].join(','),
    )
    .join('\n');
  return headers + rows;
}
