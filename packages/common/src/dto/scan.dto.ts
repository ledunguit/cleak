import { AnalysisMode, DynamicMode, DynamicToolPreference } from '../types/leak-schema.types';

export class CreateScanDto {
  workspacePath: string;
  fileLimit?: number;
  analysisMode?: AnalysisMode;
  buildCommand?: string;
  dynamicMode?: DynamicMode;
  dynamicToolPreference?: DynamicToolPreference;
  dynamicBinaryPath?: string;
  dynamicArgs?: string;
  dynamicTimeoutSec?: number;
  dynamicRunIds?: string;
  workspaceId?: string;
  repoId?: string;
}

export class UpdateScanDto {
  status?: string;
  completedAt?: string;
  report?: Record<string, unknown>;
}

export class ScanResponseDto {
  scanId: string;
  status: string;
  workspacePath: string;
  analysisMode: string;
  createdAt: string;
  completedAt?: string;
  report?: Record<string, unknown>;
  workspaceId?: string;
  repoId?: string;
}

export class ScanListResponseDto {
  scans: ScanResponseDto[];
  total: number;
}
