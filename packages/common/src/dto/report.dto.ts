export class ReportResponseDto {
  scanId: string;
  format: 'json' | 'markdown' | 'html';
  content: string;
}

export class FindingDto {
  id: string;
  functionName: string;
  filePath: string;
  lineNumber: number;
  confidence: string;
  verdict: string;
  explanation: string;
  bytesLost?: number;
  repairSuggestion?: string;
}
