// Scan-related types
import type { ReportSummary } from './report';

export interface ScanSummary {
  scanId: string;
  status: string;
  workspacePath: string;
  analysisMode: string;
  createdAt: string;
  completedAt?: string;
}

export interface ScanDetail {
  scanId: string;
  status: string;
  workspacePath: string;
  analysisMode: string;
  report?: any;
  summary?: ReportSummary;
  createdAt: string;
  completedAt?: string;
}

export interface ScanEvent {
  eventId?: string;
  scanId?: string;
  type?: string;
  event?: string;
  data?: Record<string, any>;
  [key: string]: any;
}

export interface ScanPayload {
  workspacePath: string;
  fileLimit: number;
  analysisMode: string;
  buildCommand: string | null;
  dynamicMode: string;
  dynamicBinaryPath: string | null;
  dynamicArgs: string | null;
  dynamicTimeoutSec: number | null;
  dynamicToolPreference: string | null;
  dynamicRunIds: string[];
}

export interface ScanResponse {
  scanId: string;
  filesIndexed?: number;
  candidatesFound?: number;
  summary?: ReportSummary;
  status?: string;
  error?: string;
}

export interface ScanListResponse {
  scans: ScanSummary[];
  total: number;
}
