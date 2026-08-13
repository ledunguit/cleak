/**
 * Private helper functions used by scan-store.ts — extracted to keep the
 * store module under the 200-line budget.
 */

import { SCAN_PHASE_ORDER, type ScanPhase } from '@cleak/common/flow/scan-flow-contract';
// Import the PhaseStatus type from stores/types directly — NOT the stores
// barrel (index.ts). scan-store.ts (which imports this module) is re-exported
// by the barrel, so importing the barrel here would create a module cycle:
//   stores/scan-store → surfaces/tui/store/scan-helpers → stores/index → stores/scan-store
// stores/types is a leaf type module (imports only domain + surfaces/findingView,
// never the barrel), so it keeps the stores package a clean DAG.
import type { PhaseStatus } from '../../../stores/types';

export function initialPhases(): Record<ScanPhase, PhaseStatus> {
  const p = {} as Record<ScanPhase, PhaseStatus>;
  for (const ph of SCAN_PHASE_ORDER) p[ph] = 'pending';
  return p;
}

export function phaseLabel(phase: ScanPhase): string {
  return `── ${phase.toUpperCase()} ──`;
}

const TOOL_DISPLAY: Record<string, string> = {
  scanBuildRun: 'clang-sa:scan-build',
  scanBuildGetReport: 'clang-sa:get-report',
};

export function displayToolName(n: string): string {
  return TOOL_DISPLAY[n] ?? n;
}

export function shortName(n: string): string {
  return n.replace(/_/g, ' ');
}

export function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const key = (o.functionName ?? o.bundleId ?? o.path ?? o.filePath ?? o.rootPath) as string | undefined;
  return key ? ` ${shortPath(String(key))}` : '';
}

function shortPath(p: string): string {
  const parts = p.split('/');
  return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/');
}

export function previewOutput(output: unknown, max: number): string {
  if (output == null) return '';
  if (typeof output === 'string') return output.slice(0, max);
  try { return JSON.stringify(output).slice(0, max); } catch { return ''; }
}
