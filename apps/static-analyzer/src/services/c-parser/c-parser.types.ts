// ── Public Interfaces ──

export interface FunctionInfo {
  functionName: string;
  parameters: { name: string; type: string }[];
  localVariables: { name: string; type: string }[];
  functionCalls: { name: string; line: number }[];
  allocationCalls: { name: string; line: number }[];
  deallocationCalls: { name: string; line: number }[];
  returnStatements: { line: number; text: string }[];
  conditions: { line: number; text: string }[];
  allocationVariables: { variable: string; line: number; callName: string }[];
  freedVariables: { variable: string; line: number }[];
  assignedCalls: { variable: string; line: number; callName: string }[];
  lineNumber: number;
  /** 1-based line of the function's closing brace (tree-sitter endPosition). Enables
   * accurate line→enclosing-function attribution (candidate-scan) instead of the old
   * lexical 20-line backscan / "next function − 1" heuristic. */
  endLine: number;
  // New: CFG analysis fields
  controlFlow: ControlFlowGraph;
  exitPaths: ExitPathAnalysis[];
  loops: LoopInfo[];
  gotoTargets: GotoTarget[];
}

export interface ControlFlowNode {
  id: number;
  type: 'entry' | 'exit' | 'basic_block' | 'condition' | 'loop' | 'goto' | 'label' | 'call';
  label?: string;
  line: number;
  text: string;
  hasFree: boolean;
  hasAllocation: boolean;
  allocationVars: string[];
}

export interface ControlFlowEdge {
  from: number;
  to: number;
  condition?: string;
  isTrueBranch?: boolean;
  isFalseBranch?: boolean;
  isBackEdge?: boolean;
  label?: string;
}

export interface ControlFlowGraph {
  nodes: ControlFlowNode[];
  edges: ControlFlowEdge[];
  entryNodeId: number;
  exitNodeId: number;
}

export interface ExitPathAnalysis {
  kind: 'return' | 'goto' | 'exit' | 'longjmp' | 'fallthrough';
  exitLine: number;
  reachableFromEntry: boolean;
  hasFreeOnPath: boolean;
  freeLinesOnPath: number[];
  allAllocationsFreed: boolean;
  leakRisk: 'high' | 'medium' | 'low' | 'none';
  pathConditions: string[];
  unreconciledAllocations: string[];
  /** The branch guards (with polarity) enclosing this exit, e.g. `if (p==NULL) return;`
   * → `[{condition:'p==NULL', negated:false}]`. Used by guard-subset free
   * reconciliation to match a free under the same guard as its alloc. */
  guards: { condition: string; negated: boolean }[];
}

export interface LoopInfo {
  kind: 'for' | 'while' | 'do_while';
  line: number;
  text: string;
  bodyHasAllocation: boolean;
  bodyHasFree: boolean;
  allocationVariables: string[];
}

export interface GotoTarget {
  label: string;
  gotoLine: number;
  labelLine: number;
}

export interface ParseResult {
  functions: FunctionInfo[];
  functionNames: string[];
}
