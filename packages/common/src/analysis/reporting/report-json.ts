import type { ScanReport } from '../../types';

export function toJson(report: ScanReport): string {
  return JSON.stringify(report, null, 2);
}
