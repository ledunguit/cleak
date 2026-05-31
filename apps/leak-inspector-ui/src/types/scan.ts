// Scan-related types
import type { ReportSummary } from './report';

export interface ScanSummary {
  scanId: string;
  status: string;
  workspacePath: string;
  sourceWorkspacePath?: string;
  materializedWorkspacePath?: string;
  materializedWorkspaceId?: string;
  analysisMode: string;
  createdAt: string;
  completedAt?: string;
}

export interface ScanDetail {
  scanId: string;
  status: string;
  workspacePath: string;
  sourceWorkspacePath?: string;
  materializedWorkspacePath?: string;
  materializedWorkspaceId?: string;
  analysisMode: string;
  buildCommand?: string;
  dynamicMode?: string;
  dynamicToolPreference?: string;
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
  /** Canonical event name from the shared flow contract (ScanEventName value). */
  message?: string;
  /** Canonical display phase (ScanPhase value) this event belongs to. */
  phase?: string;
  /** Contract event kind: phase_start | phase_finish | activity | terminal. */
  kind?: string;
  /** MCP tool name, when the event is a tool sub-event. */
  tool?: string;
  timestamp?: string;
  error?: string;
  data?: Record<string, any>;
  [key: string]: any;
}

export interface ScanPayload {
  workspacePath: string;
  sourceType?: 'github' | 'upload_zip' | 'local_path' | 'workspace_path';
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

export interface RuntimePreflightCheck {
  name: string;
  category: 'network' | 'filesystem' | 'toolchain';
  status: 'ok' | 'failed';
  detail: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimePreflightReport {
  ok: boolean;
  checkedAt: string;
  checks: RuntimePreflightCheck[];
}
