export interface LlmAnalysisResult {
  languages: string[];
  buildCommand: string;
  lsanSupported: boolean;
  lsanNote: string;
  filesExamined?: string[];
  thinkingTrace?: string;
}
