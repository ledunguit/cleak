import type { AnalysisMode, DynamicMode, ScanStatus, ToolKind } from './enums';
import type { LeakBundle } from './candidate';

export interface ScanMetadata {
  scanId: string;
  workspacePath: string;
  sourceWorkspacePath?: string;
  materializedWorkspacePath?: string;
  materializedWorkspaceId?: string;
  analysisMode: AnalysisMode;
  dynamicMode: DynamicMode;
  fileLimit: number;
  buildCommand?: string;
  workspaceId?: string;
  repoId?: string;
  startedAt: string;
  completedAt?: string;
  status: ScanStatus;
}

export interface ScanReport {
  scanId: string;
  metadata: ScanMetadata;
  bundles: LeakBundle[];
  summary: ReportSummary;
}

export interface ReportSummary {
  totalCandidates: number;
  confirmedLeaks: number;
  likelyLeaks: number;
  falsePositives: number;
  totalBytesLost: number;
  toolsUsed: ToolKind[];
  durationSec: number;
}
