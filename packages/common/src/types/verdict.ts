import type { InvestigationVerdict, ToolKind, LeakPatternType } from './enums';
import type { LeakCandidate } from './candidate';
import type { LeakEvidence, ControlFlowInfo } from './evidence';

export interface VerdictResult {
  verdict: InvestigationVerdict;
  confidence: number;
  explanation: string;
  evidence: string[];
  tool: ToolKind;
  repair_suggestion?: string;
  /** Structured root-cause classification (populated by the LLM judge). */
  rootCause?: LeakRootCause;
  /** Concrete before/after code fix (populated by the LLM judge). */
  repairDiff?: RepairDiff;
}

export interface LeakRootCause {
  patternType: LeakPatternType;
  description: string;
  allocationFunction: string;
  allocationLine: number;
  allocationFile: string;
  missingFreeLine?: number;
  missingFreeFunction?: string;
  rootCauseFunction: string;
  rootCauseLine: number;
  rootCauseDescription: string;
}

export interface LeakExplanation {
  rootCause: LeakRootCause;
  summary: string;
  detailedExplanation: string;
  codeFlow: string[];
  repairSuggestion: string;
  repairDiff?: RepairDiff;
}

export interface RepairDiff {
  filePath: string;
  originalLines: string[];
  suggestedLines: string[];
  startLine: number;
  description: string;
}

export interface MemoryLeakAnalysis {
  bundleId: string;
  candidate: LeakCandidate;
  controlFlow: ControlFlowInfo;
  patternTypes: LeakPatternType[];
  rootCause?: LeakRootCause;
  explanation?: LeakExplanation;
  evidence: LeakEvidence[];
  verdict?: VerdictResult;
}
