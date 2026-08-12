// ── Public Interfaces ──

export interface FunctionInfo {
  functionName: string;
  parameters: { name: string; type: string; isPointer: boolean }[];
  localVariables: { name: string; type: string }[];
  /** Return type (with trailing ` *` for pointer returns), e.g. `char *`, `int`. */
  returnType: string;
  /** `static` = internal linkage — a harness in a separate translation unit can't
   * link this function; it must #include the defining source file instead. */
  storageClass: 'static' | 'extern' | 'none';
  /** `args[i]` is the identifier name when argument i is a bare identifier, else
   * `null` (complex expression/literal/field access — not resolved, kept simple).
   * `receiver` is the object before `.`/`->` for a method call (`obj.action()`) —
   * unset for a plain function call. */
  functionCalls: { name: string; line: number; args: (string | null)[]; receiver?: string }[];
  allocationCalls: { name: string; line: number }[];
  deallocationCalls: { name: string; line: number }[];
  returnStatements: { line: number; text: string }[];
  conditions: { line: number; text: string }[];
  allocationVariables: { variable: string; line: number; callName: string }[];
  freedVariables: { variable: string; line: number }[];
  assignedCalls: { variable: string; line: number; callName: string }[];
  /** A heap-allocated variable inserted into a container: `dataVector.insert(...,
   * data)`, `dataList.push_back(data)`, `dataMap[0] = data` — the value's identity
   * survives cross-function only as `container`, not `variable`, once passed on. */
  containerCarriers: { container: string; variable: string; line: number }[];
  /** A local variable pulled back OUT of a container parameter: `char *data =
   * dataVector[2];`, `dataList.front()`/`.back()`/`.at(i)`. Ties a container-typed
   * parameter back to the local pointer variable that then needs a leak check. */
  containerExtractions: { variable: string; container: string; line: number }[];
  /** Class name for an out-of-class method definition (`ClassName::method(){}`) —
   * unset for a free function or an inline-in-class-body method (not resolved, see
   * `extractClassMembership`'s doc comment). Lets `fnIndex` disambiguate same-named
   * methods across different classes (virtual dispatch) and pair a constructor with
   * its class's destructor (RAII). */
  className?: string;
  /** `'ctor'` when `functionName === className` (out-of-class constructor
   * definition); `'dtor'` when the qualified name is `~ClassName`. Unset otherwise. */
  memberKind?: 'ctor' | 'dtor';
  /** `Base* obj = new Derived;` / `obj = new Derived(...)` — the ACTUALLY
   * constructed class, which may differ from `obj`'s declared/static type
   * (Juliet's virtual-dispatch shape constructs the derived class through a
   * base-typed pointer on purpose). See `extractConstructedTypes`'s doc comment. */
  constructedTypes: { variable: string; className: string; line: number }[];
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
