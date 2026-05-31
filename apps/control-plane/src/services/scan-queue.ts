import { CreateScanDto } from '@mcpvul/common/dto/scan.dto';

/** BullMQ queue name for detached scan execution. */
export const SCAN_QUEUE = 'scan';

/**
 * Payload enqueued by ScanService.createScan and consumed by ScanProcessor →
 * ScanService.runScanPipeline. Must be JSON-serializable (it is persisted in
 * Redis), so it carries only the resolved primitives/objects the pipeline needs
 * — never functions or class instances.
 */
export interface ScanJobData {
  scanId: string;
  scanStartedAt: string;
  executionDto: CreateScanDto;
  /** Result of ScanWorkspaceService.materializeForScan (paths + manifest + sourceType). */
  materialized: {
    sourcePath: string;
    materializedPath: string;
    analyzerVisiblePath: string;
    materializedWorkspaceId: string;
    sourceType?: string;
    manifest?: unknown;
  };
  resolvedBuildCommand?: string;
  buildPlan: unknown;
  requestedFormats: string[];
}
