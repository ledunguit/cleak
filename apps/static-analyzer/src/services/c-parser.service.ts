import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

const ALLOCATION_FUNCTIONS = new Set([
  'malloc', 'calloc', 'realloc', 'strdup', 'strndup',
  'xmalloc', 'xcalloc', 'xrealloc', 'xstrdup',
  'kmalloc', 'kcalloc', 'kzalloc', 'vmalloc',
]);

const DEALLOCATION_FUNCTIONS = new Set([
  'free', 'xfree', 'kfree', 'vfree',
]);

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
   * → `[{condition:'p==NULL', negated:false}]`. Used by the Z3 feasibility filter to
   * drop impossible leak paths (a leak of p guarded by p==NULL is UNSAT). */
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

// ── Service ──

@Injectable()
export class CParserService {
  private readonly logger = new Logger(CParserService.name);

  /** Lazily-built, reused tree-sitter parsers (C and C++), instantiated on first use. */
  private parser: any;
  private cppParser: any;
  /**
   * Parse-result cache keyed by content hash. The same file is parsed by several
   * tools (candidate-scan → ast-scan → function-summary); parsing is a pure
   * function of content, so we memoize it. Treat results as READ-ONLY — they are
   * shared across callers. Bounded LRU so a huge repo can't grow it without limit.
   */
  private readonly cache = new Map<string, ParseResult>();
  private static readonly CACHE_MAX = 512;

  /** True for C++ source/header extensions — they must be parsed by tree-sitter-cpp, not
   * tree-sitter-c (which misparses `new`/`delete`/templates/`::`/range-for). */
  static isCppPath(filePath?: string): boolean {
    return /\.(cc|cpp|cxx|c\+\+|hpp|hxx|hh|ipp|tcc|inl)$/i.test(filePath || '');
  }

  private getParser(cpp = false): any {
    if (cpp) {
      if (!this.cppParser) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Parser = require('tree-sitter');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const CPP = require('tree-sitter-cpp');
        this.cppParser = new Parser();
        this.cppParser.setLanguage(CPP);
      }
      return this.cppParser;
    }
    if (!this.parser) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Parser = require('tree-sitter');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const C = require('tree-sitter-c');
      this.parser = new Parser();
      this.parser.setLanguage(C);
    }
    return this.parser;
  }

  // Active allocator/deallocator name sets for the CURRENT (synchronous) parse.
  // Default to the built-in libc sets; `parse()` overlays per-project names (≈ LAMeD
  // AllocSource/FreeSink) so factory allocators like cJSON_Duplicate are tracked by
  // the alloc→free pairing and exit-path leak analysis (not just candidate-scan).
  private allocSet: Set<string> = ALLOCATION_FUNCTIONS;
  private freeSet: Set<string> = DEALLOCATION_FUNCTIONS;

  parse(content: string, _filePath?: string, extraAllocators?: string[], extraDeallocators?: string[]): ParseResult {
    const safe = (xs?: string[]) => (xs || []).filter((s) => /^[A-Za-z_]\w*$/.test(s)).sort();
    const ea = safe(extraAllocators);
    const ed = safe(extraDeallocators);
    const cpp = CParserService.isCppPath(_filePath);
    // Cache key includes the extra names + language — different sets/language ⇒ different parse.
    const key = createHash('sha1').update(`${cpp ? 'cpp' : 'c'} ${content} ${ea.join(',')} ${ed.join(',')}`).digest('base64');
    const hit = this.cache.get(key);
    if (hit) {
      // LRU bump: re-insert so the most-recently-used stays last.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    // Set the per-parse sets just before the SYNCHRONOUS tree-sitter walk (no await
    // in between, so no cross-call race on a shared singleton).
    this.allocSet = ea.length ? new Set([...ALLOCATION_FUNCTIONS, ...ea]) : ALLOCATION_FUNCTIONS;
    this.freeSet = ed.length ? new Set([...DEALLOCATION_FUNCTIONS, ...ed]) : DEALLOCATION_FUNCTIONS;
    const result = this.parseWithTreeSitter(content, cpp);
    this.allocSet = ALLOCATION_FUNCTIONS;
    this.freeSet = DEALLOCATION_FUNCTIONS;
    this.cache.set(key, result);
    if (this.cache.size > CParserService.CACHE_MAX) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
    return result;
  }

  private parseWithTreeSitter(content: string, cpp = false): ParseResult {
    try {
      const parser = this.getParser(cpp);
      const tree = parser.parse(content);
      const root = tree.rootNode;
      const lines = content.split('\n');

      const funcNodes = this.findAllNodes(root, 'function_definition');
      const functions: FunctionInfo[] = [];

      for (const funcNode of funcNodes) {
        const info = this.buildFunctionInfo(funcNode, lines);
        if (info) {
          // Enrich with CFG analysis
          const body = this.findChild(funcNode, 'compound_statement');
          if (body) {
            info.controlFlow = this.buildControlFlowGraph(body, lines, info);
            info.exitPaths = this.analyzeExitPaths(body, lines, info);
            info.loops = this.detectLoops(body, lines, info);
            info.gotoTargets = this.findGotoTargets(body, lines);
          } else {
            info.controlFlow = { nodes: [], edges: [], entryNodeId: 0, exitNodeId: 0 };
            info.exitPaths = [];
            info.loops = [];
            info.gotoTargets = [];
          }
          functions.push(info);
        }
      }

      return { functions, functionNames: functions.map((f) => f.functionName) };
    } catch (err: any) {
      this.logger.warn(`tree-sitter parse failed: ${err.message}`);
      return { functions: [], functionNames: [] };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // CONTROL FLOW GRAPH CONSTRUCTION
  // ═══════════════════════════════════════════════════════════════

  private buildControlFlowGraph(
    body: any,
    lines: string[],
    fn: FunctionInfo,
  ): ControlFlowGraph {
    const nodes: ControlFlowNode[] = [];
    const edges: ControlFlowEdge[] = [];
    let nodeId = 0;

    const allocVarNames = new Set(fn.allocationVariables.map((a) => a.variable));
    const freeVarNames = new Set(fn.freedVariables.map((f) => f.variable));

    // Entry node
    const entryId = nodeId++;
    nodes.push({
      id: entryId, type: 'entry', line: fn.lineNumber,
      text: `entry: ${fn.functionName}`, hasFree: false,
      hasAllocation: fn.allocationCalls.length > 0,
      allocationVars: fn.allocationVariables.map((a) => a.variable),
    });

    // Walk the compound_statement to build the CFG
    const exitId = nodeId++;
    nodes.push({
      id: exitId, type: 'exit', line: 0,
      text: 'exit', hasFree: false,
      hasAllocation: false, allocationVars: [],
    });

    const lastBlockId = this.walkStatements(body, nodes, edges, lines, nodeId, exitId, allocVarNames, freeVarNames, fn);
    nodeId = Math.max(lastBlockId, exitId + 1);

    // Connect entry to first block or exit
    const firstRealNode = nodes.find(
      (n) => n.id !== entryId && n.id !== exitId,
    );
    if (firstRealNode) {
      edges.push({ from: entryId, to: firstRealNode.id });
    } else {
      edges.push({ from: entryId, to: exitId });
    }

    return { nodes, edges, entryNodeId: entryId, exitNodeId: exitId };
  }

  private walkStatements(
    parent: any,
    nodes: ControlFlowNode[],
    edges: ControlFlowEdge[],
    lines: string[],
    nextId: number,
    exitId: number,
    allocVarNames: Set<string>,
    freeVarNames: Set<string>,
    fn: FunctionInfo,
  ): number {
    let id = nextId;
    const stmts = parent.children || [];

    for (const stmt of stmts) {
      if (!stmt.type || stmt.type === '}') continue;

      switch (stmt.type) {
        case 'if_statement': {
          const cond = this.findChild(stmt, 'parenthesized_expression');
          const condText = cond ? this.nodeText(cond, lines) : '';

          // Condition node
          const condId = id++;
          const thenBody = this.findChild(stmt, 'compound_statement');
          const elseBody = this.findChild(stmt, 'else_clause');

          nodes.push({
            id: condId, type: 'condition', line: (stmt.startPosition?.row ?? 0) + 1,
            text: `if (${condText})`, hasFree: false,
            hasAllocation: false, allocationVars: [],
          });

          // Then branch
          const thenStartId = id;
          if (thenBody) {
            id = this.walkStatements(thenBody, nodes, edges, lines, id, exitId, allocVarNames, freeVarNames, fn);
          }
          const thenEndId = id;
          edges.push({ from: condId, to: thenStartId, condition: condText, isTrueBranch: true });

          // Create a merge node after the then branch (if no else)
          const mergeId = id++;

          // Else branch
          if (elseBody) {
            const elseCompound = this.findChild(elseBody, 'compound_statement');
            const elseStartId = id;
            if (elseCompound) {
              id = this.walkStatements(elseCompound, nodes, edges, lines, id, exitId, allocVarNames, freeVarNames, fn);
            }
            const elseEndId = id;
            edges.push({ from: condId, to: elseStartId, condition: `!(${condText})`, isFalseBranch: true });

            // Connect both branches to merge
            nodes.push({
              id: mergeId, type: 'basic_block', line: (stmt.endPosition?.row ?? 0) + 1,
              text: '(merge after if/else)', hasFree: false,
              hasAllocation: false, allocationVars: [],
            });
            if (thenEndId > thenStartId) {
              edges.push({ from: thenEndId - 1, to: mergeId });
            }
            if (elseEndId > elseStartId) {
              edges.push({ from: elseEndId - 1, to: mergeId });
            }
            if (thenEndId === thenStartId) {
              edges.push({ from: condId, to: mergeId, isTrueBranch: true });
            }
            if (elseEndId === elseStartId) {
              edges.push({ from: condId, to: mergeId, isFalseBranch: true });
            }
          } else {
            // No else: connect condition → then block AND condition → merge
            edges.push({ from: condId, to: thenStartId, condition: condText, isTrueBranch: true });
            edges.push({ from: condId, to: mergeId, condition: `!(${condText})`, isFalseBranch: true });
          }

          id = mergeId + 1;
          break;
        }

        case 'for_statement':
        case 'while_statement':
        case 'do_statement': {
          const loopKind = stmt.type === 'for_statement' ? 'for'
            : stmt.type === 'while_statement' ? 'while' : 'do_while';
          const loopText = this.nodeText(stmt, lines).slice(0, 80);

          // Loop header node
          const loopId = id++;
          const loopBody = this.findChild(stmt, 'compound_statement');
          const bodyText = loopBody ? this.nodeText(loopBody, lines).slice(0, 80) : '';

          nodes.push({
            id: loopId, type: 'loop', line: (stmt.startPosition?.row ?? 0) + 1,
            text: loopText || bodyText, hasFree: false,
            hasAllocation: false, allocationVars: [],
          });

          // Loop body
          const bodyStartId = id;
          if (loopBody) {
            id = this.walkStatements(loopBody, nodes, edges, lines, id, exitId, allocVarNames, freeVarNames, fn);
          }

          // Back-edge from body to loop header
          if (id > bodyStartId) {
            edges.push({ from: id - 1, to: loopId, isBackEdge: true });
          } else {
            edges.push({ from: loopId, to: loopId, isBackEdge: true });
          }

          // Exit edge from loop header
          const afterLoopId = id++;
          nodes.push({
            id: afterLoopId, type: 'basic_block', line: (stmt.endPosition?.row ?? 0) + 1,
            text: '(after loop)', hasFree: false,
            hasAllocation: false, allocationVars: [],
          });
          edges.push({ from: loopId, to: afterLoopId });
          id = afterLoopId + 1;
          break;
        }

        case 'return_statement': {
          const retText = this.nodeText(stmt, lines).slice(0, 60);
          const retId = id++;
          // (CFG return node is informational; path-sensitive free reconciliation lives in
          // analyzeExitPaths. Don't fake hasFree with a ±3-line proximity guess.)
          nodes.push({
            id: retId, type: 'basic_block', line: (stmt.startPosition?.row ?? 0) + 1,
            text: retText, hasFree: false,
            hasAllocation: false, allocationVars: [],
          });
          edges.push({ from: retId, to: exitId });
          id = retId + 1;
          break;
        }

        case 'goto_statement': {
          const gotoId = id++;
          const label = this.extractGotoLabel(stmt, lines);
          nodes.push({
            id: gotoId, type: 'goto', line: (stmt.startPosition?.row ?? 0) + 1,
            text: `goto ${label}`, hasFree: false,
            hasAllocation: false, allocationVars: [],
          });
          edges.push({ from: gotoId, to: exitId, label });
          id = gotoId + 1;
          break;
        }

        case 'labeled_statement': {
          const labelId = id++;
          const labelName = this.nodeText(stmt.children?.[0], lines) || '';
          const innerBody = this.findChild(stmt, 'compound_statement');
          nodes.push({
            id: labelId, type: 'label', line: (stmt.startPosition?.row ?? 0) + 1,
            text: `${labelName}:`, hasFree: false,
            hasAllocation: false, allocationVars: [],
          });
          if (innerBody) {
            id = this.walkStatements(innerBody, nodes, edges, lines, id, exitId, allocVarNames, freeVarNames, fn);
          }
          break;
        }

        case 'compound_statement': {
          id = this.walkStatements(stmt, nodes, edges, lines, id, exitId, allocVarNames, freeVarNames, fn);
          break;
        }

        case 'expression_statement':
        case 'declaration': {
          const stmtText = this.nodeText(stmt, lines).slice(0, 80);
          // Walk the AST (not regex on truncated text, which misreads `log(x); free(p);`
          // and casts/subscripts) — `free()` at ANY position counts; an allocator call on
          // an assignment RHS sets hasAllocation + captures the LHS var.
          let hasFree = false;
          let hasAlloc = false;
          const allocVars: string[] = [];
          for (const call of this.findAllNodes(stmt, 'call_expression')) {
            const name = this.nodeText(this.getCallFunctionNameNode(call), lines);
            if (this.freeSet.has(name)) hasFree = true;
            if (this.allocSet.has(name)) hasAlloc = true;
          }
          // C++ `new T(...)` is an allocation too (not a call_expression).
          if (this.findAllNodes(stmt, 'new_expression').length > 0) hasAlloc = true;
          if (hasAlloc) {
            // The LHS variable of `var = [cast] alloc(...)` / `T* var = new T()`.
            const decl = this.findChild(stmt, 'init_declarator');
            const assign = this.findAllNodes(stmt, 'assignment_expression')[0];
            const lhs = decl ? this.extractDeclaratorName(decl, lines) : assign?.children?.[0] ? this.nodeText(assign.children[0], lines) : '';
            if (lhs) allocVars.push(lhs);
          }

          const blockId = id++;
          nodes.push({
            id: blockId, type: 'basic_block', line: (stmt.startPosition?.row ?? 0) + 1,
            text: stmtText, hasFree, hasAllocation: hasAlloc,
            allocationVars: allocVars,
          });
          id = blockId + 1;
          break;
        }

        default:
          break;
      }
    }

    return id;
  }

  // ═══════════════════════════════════════════════════════════════
  // EXIT PATH ANALYSIS
  // ═══════════════════════════════════════════════════════════════

  private analyzeExitPaths(
    body: any,
    lines: string[],
    fn: FunctionInfo,
  ): ExitPathAnalysis[] {
    const paths: ExitPathAnalysis[] = [];

    // Per-line branch guards (with polarity) — the conditions enclosing each line.
    const lineGuards = this.collectLineGuards(body, lines);
    const guardsAt = (line: number) => lineGuards.get(line) ?? [];
    // A free reconciles a return iff it precedes it AND lies on the SAME path: every
    // guard the free is under must also guard the return (guard-subset). This makes a
    // `free()` inside a branch that RETURNS (e.g. cJSON's `cJSON_Delete(target)` in the
    // `if(!isObject)` block) NOT reconcile a later exit on the fall-through path.
    const subsetOf = (
      a: { condition: string; negated: boolean }[],
      b: { condition: string; negated: boolean }[],
    ) => a.every((g) => b.some((h) => h.condition === g.condition && h.negated === g.negated));

    // F3 — pointer parameters the function FREES somewhere ("manages") leak on any path
    // that loses them, even though they have no allocation site in the function.
    const pointerParams = fn.parameters.filter((p) => (p.type || '').includes('*')).map((p) => p.name);
    const everFreed = new Set(fn.freedVariables.map((f) => f.variable));
    const managedParams = pointerParams.filter((p) => everFreed.has(p));

    const reconciledAt = (exitLine: number, exitGuards: { condition: string; negated: boolean }[]) =>
      new Set(
        fn.freedVariables
          .filter((f) => f.line <= exitLine && subsetOf(guardsAt(f.line), exitGuards))
          .map((f) => f.variable),
      );

    // Provably-dead lines: statements after an UNCONDITIONAL terminator (return/goto/exit
    // …) in the same block can never run, so an exit there is not a real leak path.
    const dead = this.collectDeadLines(body, lines);

    // Analyze each return statement
    for (const ret of fn.returnStatements) {
      const retGuards = guardsAt(ret.line);
      const reconciled = reconciledAt(ret.line, retGuards);
      // Path-sensitive: only frees on THE SAME path (guard-subset) count as "freed on
      // this exit" — a free in a returning sibling branch must not fake hasFreeOnPath.
      const pathFrees = fn.freedVariables.filter((f) => f.line <= ret.line && subsetOf(guardsAt(f.line), retGuards));
      const allocUnrec = fn.allocationVariables
        .filter((a) => a.line <= ret.line && !reconciled.has(a.variable))
        .map((a) => a.variable);
      const paramUnrec = managedParams.filter((p) => !reconciled.has(p));
      const unreconciled = [...new Set([...allocUnrec, ...paramUnrec])];

      paths.push({
        kind: 'return',
        exitLine: ret.line,
        reachableFromEntry: !dead.has(ret.line),
        hasFreeOnPath: pathFrees.length > 0,
        freeLinesOnPath: pathFrees.map((f) => f.line),
        allAllocationsFreed: unreconciled.length === 0,
        leakRisk: unreconciled.length > 0 ? 'high' : 'none',
        pathConditions: this.inferPathConditions(fn, ret.line),
        unreconciledAllocations: unreconciled,
        guards: retGuards,
      });
    }

    // No return statements = fallthrough to end of function
    if (fn.returnStatements.length === 0) {
      const lastLine = fn.returnStatements.length > 0
        ? Math.max(...fn.returnStatements.map((r) => r.line))
        : (body.endPosition?.row ?? 0) + 1;

      const unreconciled = fn.allocationVariables
        .filter((a) => !fn.freedVariables.some((f) => f.variable === a.variable))
        .map((a) => a.variable);

      paths.push({
        kind: 'fallthrough',
        exitLine: lastLine,
        reachableFromEntry: true,
        hasFreeOnPath: fn.deallocationCalls.length > 0,
        freeLinesOnPath: fn.freedVariables.map((f) => f.line),
        allAllocationsFreed: unreconciled.length === 0,
        leakRisk: unreconciled.length > 0 ? 'high' : 'none',
        pathConditions: [],
        unreconciledAllocations: unreconciled,
        // The fall-through end is a MERGE of all paths — guard-subset would under-
        // reconcile here (a var freed on both branches of an if has a guard on each),
        // so this exit stays conservative (freed-anywhere reconciles) with no guards.
        guards: [],
      });
    }

    return paths;
  }

  /**
   * Map each line to the branch guards (with polarity) that enclose it, via a
   * guard-tracking walk of the AST. A line inside `if (c) {...}` carries
   * `{condition:'c', negated:false}`; inside the `else`, `negated:true`. Powers
   * path-sensitive free reconciliation (guard-subset) and Z3 feasibility.
   */
  private collectLineGuards(
    body: any,
    lines: string[],
  ): Map<number, { condition: string; negated: boolean }[]> {
    const map = new Map<number, { condition: string; negated: boolean }[]>();
    const walk = (node: any, stack: { condition: string; negated: boolean }[]) => {
      if (!node) return;
      const line = (node.startPosition?.row ?? -1) + 1;
      // DEEPER guard stack wins for a line: a single-line `if (p==NULL) return;` puts
      // the if-condition and the return on the SAME line; the return (deeper, guarded
      // by p==NULL) must win over the if header (outer, unguarded).
      if (line > 0) {
        const existing = map.get(line);
        if (!existing || stack.length > existing.length) map.set(line, stack);
      }
      if (node.type === 'if_statement') {
        const condNode = node.childForFieldName?.('condition') ?? this.findChild(node, 'parenthesized_expression');
        const condText = condNode ? this.stripParens(this.nodeText(condNode, lines)) : '';
        const cons = node.childForFieldName?.('consequence');
        const alt = node.childForFieldName?.('alternative') ?? this.findChild(node, 'else_clause');
        const g = (neg: boolean) =>
          condText ? [...stack, { condition: condText, negated: neg }] : stack;
        if (condNode) walk(condNode, stack);
        // `consequence`: prefer the field; fall back to the first non-condition child.
        if (cons) walk(cons, g(false));
        else {
          for (const child of node.children || []) {
            if (child === condNode || child === alt) continue;
            if (child.type === 'parenthesized_expression') continue;
            walk(child, g(false));
            break;
          }
        }
        if (alt) walk(alt, g(true));
        return;
      }
      // C `switch (e) { case K: … }` — statements inside `case K:` are guarded by `e == K`
      // (additive: improves feasibility for switch-cleanup dispatch without touching
      // if/loop handling). Fall-through is approximated by the nearest case label.
      if (node.type === 'switch_statement') {
        const condNode = node.childForFieldName?.('condition') ?? this.findChild(node, 'parenthesized_expression');
        const sw = condNode ? this.stripParens(this.nodeText(condNode, lines)) : '';
        if (condNode) walk(condNode, stack);
        const swBody = node.childForFieldName?.('body') ?? this.findChild(node, 'compound_statement');
        for (const c of swBody?.children || []) {
          if (c.type !== 'case_statement') {
            walk(c, stack);
            continue;
          }
          const valNode = (c.children || []).find(
            (x: any) => x.type === 'number_literal' || x.type === 'char_literal' || x.type === 'identifier',
          );
          const guard = sw && valNode ? [...stack, { condition: `${sw} == ${this.nodeText(valNode, lines)}`, negated: false }] : stack;
          walk(c, guard);
        }
        return;
      }
      for (const child of node.children || []) walk(child, stack);
    };
    walk(body, []);
    return map;
  }

  /** Functions that do not return — code after them in the same block is unreachable. */
  private static readonly NORETURN_CALLS = new Set([
    'exit', '_exit', '_Exit', 'abort', 'longjmp', 'siglongjmp', '__builtin_unreachable', '__builtin_trap', 'panic',
  ]);

  /**
   * 1-based lines that are PROVABLY unreachable: a statement after an UNCONDITIONAL
   * terminator (return / goto / exit()/abort()/longjmp()/_Noreturn) at the SAME block
   * level, up to the next `labeled_statement`/`case_statement` (a goto/switch target
   * resets reachability). Conservative on purpose: a terminator inside an if/loop is
   * CONDITIONAL, so it does NOT kill its siblings — meaning we only ever drop code that
   * genuinely cannot run, so an exit-path filtered by this can never hide a real leak.
   */
  private collectDeadLines(body: any, lines: string[]): Set<number> {
    const dead = new Set<number>();
    const markSubtree = (node: any) => {
      const ln = (node.startPosition?.row ?? -1) + 1;
      if (ln > 0) dead.add(ln);
      for (const c of node.children || []) markSubtree(c);
    };
    const isTerminator = (stmt: any): boolean => {
      if (stmt.type === 'return_statement' || stmt.type === 'goto_statement') return true;
      if (stmt.type === 'expression_statement') {
        const call = this.findAllNodes(stmt, 'call_expression')[0];
        const fnNode = call ? this.getCallFunctionNameNode(call) : null;
        const name = fnNode ? this.nodeText(fnNode, lines) : '';
        return CParserService.NORETURN_CALLS.has(name);
      }
      return false;
    };
    const walk = (node: any) => {
      if (!node) return;
      if (node.type === 'compound_statement') {
        let terminated = false;
        for (const stmt of node.children || []) {
          if (stmt.type === '{' || stmt.type === '}' || stmt.type === 'comment') continue;
          if (terminated) {
            if (stmt.type === 'labeled_statement' || stmt.type === 'case_statement') terminated = false;
            else markSubtree(stmt);
          }
          if (!terminated && isTerminator(stmt)) terminated = true;
        }
      }
      for (const c of node.children || []) walk(c);
    };
    walk(body);
    return dead;
  }

  /** Strip fully-enclosing outer parentheses: `((p == NULL))` → `p == NULL`. */
  private stripParens(s: string): string {
    let t = s.trim();
    while (t.startsWith('(') && t.endsWith(')')) {
      let depth = 0;
      let matched = true;
      for (let i = 0; i < t.length; i++) {
        if (t[i] === '(') depth++;
        else if (t[i] === ')') {
          depth--;
          if (depth === 0 && i < t.length - 1) {
            matched = false;
            break;
          }
        }
      }
      if (!matched) break;
      t = t.slice(1, -1).trim();
    }
    return t;
  }

  private inferPathConditions(fn: FunctionInfo, targetLine: number): string[] {
    const conditions: string[] = [];
    for (const cond of fn.conditions) {
      if (cond.line < targetLine) {
        conditions.push(cond.text.slice(0, 60));
      }
    }
    return conditions;
  }

  // ═══════════════════════════════════════════════════════════════
  // LOOP DETECTION
  // ═══════════════════════════════════════════════════════════════

  private detectLoops(
    body: any,
    lines: string[],
    fn: FunctionInfo,
  ): LoopInfo[] {
    const loops: LoopInfo[] = [];

    const forNodes = this.findAllNodes(body, 'for_statement');
    const whileNodes = this.findAllNodes(body, 'while_statement');
    const doNodes = this.findAllNodes(body, 'do_statement');

    for (const node of forNodes) {
      const loopBody = this.findChild(node, 'compound_statement');
      loops.push(this.buildLoopInfo('for', node, loopBody, lines, fn));
    }

    for (const node of whileNodes) {
      const loopBody = this.findChild(node, 'compound_statement');
      loops.push(this.buildLoopInfo('while', node, loopBody, lines, fn));
    }

    for (const node of doNodes) {
      const loopBody = this.findChild(node, 'compound_statement');
      loops.push(this.buildLoopInfo('do_while', node, loopBody, lines, fn));
    }

    return loops;
  }

  private buildLoopInfo(
    kind: LoopInfo['kind'],
    node: any,
    body: any | undefined,
    lines: string[],
    fn: FunctionInfo,
  ): LoopInfo {
    const line = (node.startPosition?.row ?? 0) + 1;
    const text = this.nodeText(node, lines).slice(0, 80);

    const bodyAllocCalls = body
      ? this.findAllNodes(body, 'call_expression').filter((c: any) => {
          const name = this.nodeText(this.getCallFunctionNameNode(c), lines);
          return this.allocSet.has(name);
        })
      : [];

    const bodyFreeCalls = body
      ? this.findAllNodes(body, 'call_expression').filter((c: any) => {
          const name = this.nodeText(this.getCallFunctionNameNode(c), lines);
          return this.freeSet.has(name);
        })
      : [];

    const allocVars: string[] = [];
    for (const alloc of fn.allocationVariables) {
      if (alloc.line >= line && alloc.line <= (node.endPosition?.row ?? 0) + 1) {
        allocVars.push(alloc.variable);
      }
    }

    return {
      kind,
      line,
      text,
      bodyHasAllocation: bodyAllocCalls.length > 0,
      bodyHasFree: bodyFreeCalls.length > 0,
      allocationVariables: allocVars,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // GOTO TARGET DETECTION
  // ═══════════════════════════════════════════════════════════════

  private findGotoTargets(body: any, lines: string[]): GotoTarget[] {
    const targets: GotoTarget[] = [];

    const gotoNodes = this.findAllNodes(body, 'goto_statement');
    const labelNodes = this.findAllNodes(body, 'labeled_statement');

    for (const g of gotoNodes) {
      const labelName = this.extractGotoLabel(g, lines);
      const labelNode = labelNodes.find((l: any) => {
        const name = this.nodeText(l.children?.[0], lines);
        return name === labelName;
      });

      targets.push({
        label: labelName,
        gotoLine: (g.startPosition?.row ?? 0) + 1,
        labelLine: labelNode ? (labelNode.startPosition?.row ?? 0) + 1 : 0,
      });
    }

    return targets;
  }

  private extractGotoLabel(node: any, lines: string[]): string {
    const children = node.children || [];
    // goto_statement: 'goto' identifier ';'
    const idNode = children.find(
      (c: any) => c.type === 'identifier',
    );
    return idNode ? this.nodeText(idNode, lines) : 'unknown';
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPER: Allocation variable analysis with struct field tracking
  // ═══════════════════════════════════════════════════════════════

  private extractAllocationVariables(
    node: any,
    lines: string[],
    allocationCalls: { name: string; line: number }[],
  ): { variable: string; line: number; callName: string }[] {
    const body = this.findChild(node, 'compound_statement');
    if (!body) return [];

    const result: { variable: string; line: number; callName: string }[] = [];

    // Track variables that receive allocation results
    // Pattern: type *var = malloc(...) or var = malloc(...)
    const allInitDecls = this.findAllNodes(body, 'init_declarator');
    for (const decl of allInitDecls) {
      const callExprs = this.findAllNodes(decl, 'call_expression');
      let matched = false;
      for (const expr of callExprs) {
        const fnNode = this.getCallFunctionNameNode(expr);
        const name = fnNode ? this.nodeText(fnNode, lines) : '';
        if (this.allocSet.has(name)) {
          const varName = this.extractDeclaratorName(decl, lines);
          if (varName) {
            result.push({
              variable: varName,
              line: (decl.startPosition?.row ?? 0) + 1,
              callName: name,
            });
            matched = true;
          }
        }
      }
      // C++ `T* p = new T(...)` — a new_expression, not a call_expression.
      if (!matched && this.findAllNodes(decl, 'new_expression').length > 0) {
        const varName = this.extractDeclaratorName(decl, lines);
        if (varName) result.push({ variable: varName, line: (decl.startPosition?.row ?? 0) + 1, callName: 'new' });
      }
    }

    // Track struct field allocations: p->field = malloc(...) or s.field = malloc(...)
    const allAssignments = this.findAllNodes(body, 'assignment_expression');
    for (const expr of allAssignments) {
      const right = expr.children?.[expr.children.length - 1];
      if (right) {
        const left = expr.children?.[0];
        const callExprs = this.findAllNodes(right, 'call_expression');
        let matched = false;
        for (const callExpr of callExprs) {
          const fnNode = this.getCallFunctionNameNode(callExpr);
          const name = fnNode ? this.nodeText(fnNode, lines) : '';
          if (this.allocSet.has(name)) {
            if (left) {
              const fieldText = this.nodeText(left, lines);
              // Handle both p->field and s.field
              result.push({
                variable: fieldText,
                line: (left.startPosition?.row ?? 0) + 1,
                callName: name,
              });
              matched = true;
            }
          }
        }
        // C++ `p = new T(...)` on the RHS of an assignment.
        if (!matched && left && this.findAllNodes(right, 'new_expression').length > 0) {
          result.push({ variable: this.nodeText(left, lines), line: (left.startPosition?.row ?? 0) + 1, callName: 'new' });
        }
      }
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  // All existing helper methods preserved below
  // ═══════════════════════════════════════════════════════════════

  private findAllNodes(node: any, targetType: string): any[] {
    const found: any[] = [];
    if (node.type === targetType) {
      found.push(node);
    }
    for (const child of node.children || []) {
      found.push(...this.findAllNodes(child, targetType));
    }
    return found;
  }

  private findChild(node: any, targetType: string): any | undefined {
    return (node.children || []).find((c: any) => c.type === targetType);
  }

  private nodeText(node: any, lines: string[]): string {
    if (!node || node.startIndex == null) return '';
    let text = '';
    if (node.startPosition?.row === node.endPosition?.row) {
      text = lines[node.startPosition.row]?.substring(
        node.startPosition.column, node.endPosition.column,
      ) || '';
    } else {
      text = lines[node.startPosition.row]?.substring(node.startPosition.column) || '';
      for (let r = node.startPosition.row + 1; r <= node.endPosition.row; r++) {
        if (r < lines.length) {
          text += '\n' + (r === node.endPosition.row
            ? lines[r].substring(0, node.endPosition.column)
            : lines[r]);
        }
      }
    }
    return text.trim();
  }

  private extractFunctionName(node: any, lines: string[]): string {
    const declarator = this.findChild(node, 'function_declarator') ||
                       this.findChild(node, 'pointer_declarator');
    if (!declarator) return 'unknown';

    // Case 1: direct identifier (e.g., "int foo(...) -> function_declarator -> identifier")
    const directId = this.findChild(declarator, 'identifier');
    if (directId) return this.nodeText(directId, lines);

    // Case 2: pointer_declarator -> function_declarator -> identifier
    // (e.g., "char *foo(...) -> pointer_declarator -> function_declarator -> identifier")
    const innerFuncDecl = this.findChild(declarator, 'function_declarator');
    if (innerFuncDecl) {
      const innerId = this.findChild(innerFuncDecl, 'identifier');
      if (innerId) return this.nodeText(innerId, lines);
    }

    // Case 3: recursive pointer_declarator (e.g., "char **foo(...)")
    const innerPtrDecl = this.findChild(declarator, 'pointer_declarator');
    if (innerPtrDecl) {
      const chainId = this.findChild(innerPtrDecl, 'identifier');
      if (chainId) return this.nodeText(chainId, lines);
      const chainFunc = this.findChild(innerPtrDecl, 'function_declarator');
      if (chainFunc) {
        const chainFuncId = this.findChild(chainFunc, 'identifier');
        if (chainFuncId) return this.nodeText(chainFuncId, lines);
      }
    }

    // Fallback: find any identifier in the declarator subtree
    const allIds = this.findAllNodes(declarator, 'identifier');
    if (allIds.length > 0) return this.nodeText(allIds[0], lines);

    return 'unknown';
  }

  private extractParameters(node: any, lines: string[]): { name: string; type: string }[] {
    const topDecl = (node.children || []).find(
      (c: any) => c.type === 'function_declarator' || c.type === 'pointer_declarator',
    );
    if (!topDecl) return [];
    // `cJSON *foo(...)` nests as pointer_declarator > function_declarator > parameter_list,
    // so a one-level lookup misses every pointer-returning function. Descend to the
    // function_declarator within the declarator (not the body) before reading params.
    const funcDecl =
      topDecl.type === 'function_declarator' ? topDecl : this.findAllNodes(topDecl, 'function_declarator')[0];
    const paramList = funcDecl ? this.findChild(funcDecl, 'parameter_list') : undefined;
    if (!paramList) return [];

    return (paramList.children || [])
      .filter((c: any) => c.type === 'parameter_declaration')
      .map((param: any) => {
        const typeNames = (param.children || [])
          .filter((c: any) =>
            ['primitive_type', 'type_identifier', 'sized_type_specifier', 'struct_specifier'].includes(c.type),
          )
          .map((c: any) => this.nodeText(c, lines));
        const declaratorChild = param.children?.find(
          (c: any) => c.type === 'identifier' ||
            c.type === 'pointer_declarator' ||
            c.type === 'array_declarator',
        );
        // For `char *target`, the '*' lives in the pointer_declarator, so the raw text
        // is `*target` and the type is just `char`. Extract the bare identifier as the
        // NAME (so it matches freedVariables) and mark the TYPE as a pointer (so the
        // pointer-parameter checks fire). Same for `char target[]` (array → pointer).
        const isPointer =
          declaratorChild?.type === 'pointer_declarator' || declaratorChild?.type === 'array_declarator';
        let name = '';
        if (declaratorChild) {
          if (isPointer) {
            const id = this.findAllNodes(declaratorChild, 'identifier')[0];
            name = id ? this.nodeText(id, lines) : this.nodeText(declaratorChild, lines).replace(/[*[\]\s]/g, '');
          } else {
            name = this.nodeText(declaratorChild, lines);
          }
        }
        const type = (typeNames.join(' ') || 'int') + (isPointer ? ' *' : '');
        return { name, type };
      });
  }

  private extractLocalVariables(node: any, lines: string[]): { name: string; type: string }[] {
    const body = this.findChild(node, 'compound_statement');
    if (!body) return [];

    const result: { name: string; type: string }[] = [];
    const decls = this.findAllNodes(body, 'declaration');

    for (const decl of decls) {
      const typeNode = (decl.children || []).find(
        (c: any) =>
          ['primitive_type', 'type_identifier', 'sized_type_specifier', 'struct_specifier'].includes(c.type),
      );
      const typeText = typeNode ? this.nodeText(typeNode, lines) : 'int';
      const initDecls = this.findChildren(decl, 'init_declarator');

      for (const initDecl of initDecls) {
        const name = this.extractDeclaratorName(initDecl, lines);
        if (name) result.push({ name, type: typeText });
      }
    }

    return result;
  }

  private extractDeclaratorName(declaratorNode: any, lines: string[]): string {
    const id = this.findChild(declaratorNode, 'identifier');
    if (id) return this.nodeText(id, lines);
    const ptrDecl = this.findChild(declaratorNode, 'pointer_declarator');
    if (ptrDecl) {
      const ptrId = this.findChild(ptrDecl, 'identifier');
      if (ptrId) return this.nodeText(ptrId, lines);
    }
    return '';
  }

  private findChildren(node: any, targetType: string): any[] {
    return (node.children || []).filter((c: any) => c.type === targetType);
  }

  private extractFunctionCalls(body: any, lines: string[]): { name: string; line: number }[] {
    const calls: { name: string; line: number }[] = [];
    const callExprs = this.findAllNodes(body, 'call_expression');
    const visited = new Set<string>();

    for (const expr of callExprs) {
      const fnNode = this.getCallFunctionNameNode(expr);
      if (!fnNode) continue;
      const name = this.nodeText(fnNode, lines);
      if (!name) continue;

      const key = `${name}:${(expr.startPosition?.row ?? 0) + 1}`;
      if (visited.has(key)) continue;
      visited.add(key);

      calls.push({ name, line: (expr.startPosition?.row ?? 0) + 1 });
    }

    return calls;
  }

  private getCallFunctionNameNode(expr: any): any {
    const children = expr.children || [];
    const first = children[0];
    if (!first) return null;

    if (first.type === 'identifier') return first;

    // Handle nested calls like func()() or foo->method()
    if (first.type === 'field_expression') {
      return this.findChild(first, 'field_identifier');
    }
    if (first.type === 'pointer_expression') {
      return this.findChild(first, 'identifier');
    }

    return null;
  }

  private isAllocationCall(node: any, lines: string[]): boolean {
    const callExprs = this.findAllNodes(node, 'call_expression');
    for (const expr of callExprs) {
      const fnNode = this.getCallFunctionNameNode(expr);
      if (fnNode && this.allocSet.has(this.nodeText(fnNode, lines))) {
        return true;
      }
    }
    return false;
  }

  private buildFunctionInfo(funcNode: any, lines: string[]): FunctionInfo | null {
    try {
      const body = this.findChild(funcNode, 'compound_statement');
      if (!body) return null;

      const functionName = this.extractFunctionName(funcNode, lines);
      const parameters = this.extractParameters(funcNode, lines);
      const localVariables = this.extractLocalVariables(funcNode, lines);
      const functionCalls = this.extractFunctionCalls(body, lines);
      // Use the per-parse sets so project allocators/deallocators (e.g. cJSON_Delete,
      // cJSON_Duplicate) — supplied via parse(...extraAllocators/extraDeallocators) —
      // are recognized here, not just the built-in libc names.
      const allocationCalls = functionCalls.filter((c) => this.allocSet.has(c.name));
      const deallocationCalls = functionCalls.filter((c) => this.freeSet.has(c.name));
      const returnStatements = this.extractReturnStatements(funcNode, lines);
      const conditions = this.extractConditions(funcNode, lines);
      const allocationVariables = this.extractAllocationVariables(funcNode, lines, allocationCalls);
      const freedVariables = this.extractFreedVariables(funcNode, lines, deallocationCalls);
      const assignedCalls = this.extractAssignedCalls(funcNode, lines);

      const fn: FunctionInfo = {
        functionName,
        parameters,
        localVariables,
        functionCalls,
        allocationCalls,
        deallocationCalls,
        returnStatements,
        conditions,
        allocationVariables,
        freedVariables,
        assignedCalls,
        lineNumber: (funcNode.startPosition?.row ?? 0) + 1,
        endLine: (funcNode.endPosition?.row ?? 0) + 1,
        controlFlow: { nodes: [], edges: [], entryNodeId: 0, exitNodeId: 0 },
        exitPaths: [],
        loops: [],
        gotoTargets: [],
      };

      return fn;
    } catch {
      return null;
    }
  }

  private extractReturnStatements(node: any, lines: string[]): { line: number; text: string }[] {
    const body = this.findChild(node, 'compound_statement');
    if (!body) return [];
    return this.findAllNodes(body, 'return_statement').map((ret) => ({
      line: (ret.startPosition?.row ?? 0) + 1,
      text: this.nodeText(ret, lines),
    }));
  }

  private extractConditions(node: any, lines: string[]): { line: number; text: string }[] {
    const body = this.findChild(node, 'compound_statement');
    if (!body) return [];
    return this.findAllNodes(body, 'if_statement').map((ifStmt) => ({
      line: (ifStmt.startPosition?.row ?? 0) + 1,
      text: this.nodeText(ifStmt, lines),
    }));
  }

  private extractFreedVariables(
    node: any,
    lines: string[],
    deallocCalls: { name: string; line: number }[],
  ): { variable: string; line: number }[] {
    const body = this.findChild(node, 'compound_statement');
    if (!body) return [];
    const result: { variable: string; line: number }[] = [];
    const allExprs = this.findAllNodes(body, 'call_expression');

    for (const call of deallocCalls) {
      const expr = allExprs.find(
        (e: any) => (e.startPosition?.row ?? 0) + 1 === call.line,
      );
      if (!expr) continue;
      const args = expr.children?.find((c: any) => c.type === 'argument_list');
      // argument_list children are `( arg0 , arg1 )` — children[0] is the OPENING PAREN,
      // not the argument. Take the first real argument so `free(p)` records `p`.
      const firstArg = args?.children?.find(
        (c: any) => c.type !== '(' && c.type !== ')' && c.type !== ',',
      );
      if (firstArg) {
        const varName = this.nodeText(firstArg, lines);
        result.push({ variable: varName, line: call.line });
      }
    }

    // C++ `delete p;` / `delete[] p;` — a delete_expression, not a call. The operand is
    // the last child (the identifier being deleted).
    for (const del of this.findAllNodes(body, 'delete_expression')) {
      const operand = (del.children || []).filter((c: any) => c.type === 'identifier' || c.type === 'field_expression' || c.type === 'subscript_expression').pop();
      if (operand) result.push({ variable: this.nodeText(operand, lines), line: (del.startPosition?.row ?? 0) + 1 });
    }

    return result;
  }

  private extractAssignedCalls(node: any, lines: string[]): { variable: string; line: number; callName: string }[] {
    const body = this.findChild(node, 'compound_statement');
    if (!body) return [];

    const result: { variable: string; line: number; callName: string }[] = [];

    const initDecls = this.findAllNodes(body, 'init_declarator');
    for (const decl of initDecls) {
      const callExprs = this.findAllNodes(decl, 'call_expression');
      if (callExprs.length > 0 && !this.isAllocationCall(decl, lines)) {
        const varName = this.extractDeclaratorName(decl, lines);
        if (varName) {
          const fnNode = this.getCallFunctionNameNode(callExprs[0]);
          const callName = fnNode ? this.nodeText(fnNode, lines) : '';
          result.push({ variable: varName, line: (decl.startPosition?.row ?? 0) + 1, callName });
        }
      }
    }

    const assignExprs = this.findAllNodes(body, 'assignment_expression');
    for (const expr of assignExprs) {
      const right = expr.children?.[expr.children.length - 1];
      if (right) {
        const callExprs = this.findAllNodes(right, 'call_expression');
        if (callExprs.length > 0 && !this.isAllocationCall(right, lines)) {
          const left = expr.children?.[0];
          const varName = left ? this.nodeText(left, lines) : '';
          if (varName) {
            const fnNode = this.getCallFunctionNameNode(callExprs[0]);
            const callName = fnNode ? this.nodeText(fnNode, lines) : '';
            result.push({ variable: varName, line: (left?.startPosition?.row ?? 0) + 1, callName });
          }
        }
      }
    }

    return result;
  }
}
