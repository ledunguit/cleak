// ── Static analysis / AST types ──

export interface AstNode {
  type: string;
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
  text: string;
  children: AstNode[];
}

export interface CallGraphEdge {
  caller: string;
  callee: string;
  filePath: string;
  lineNumber: number;
}

export interface CallGraphNode {
  functionName: string;
  filePath: string;
}

export interface FlowPath {
  functionName: string;
  filePath: string;
  lines: number[];
}

export interface OwnershipInfo {
  functionName: string;
  filePath: string;
  ownershipType: string;
  allocatedObjects: string[];
}

export interface OwnershipRule {
  pattern: string;
  description: string;
  conventionType: string;
}
