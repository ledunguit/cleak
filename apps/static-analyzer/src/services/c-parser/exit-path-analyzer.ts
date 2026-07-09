import type { TreeSitterNode } from '../../types/tree-sitter';
import type { FunctionInfo, ExitPathAnalysis } from './c-parser.types';
import { findAllNodes, findChild, nodeText, getCallFunctionNameNode, stripParens } from './ast-utils';

// ── EXIT PATH ANALYSIS ──

/** Functions that do not return — code after them in the same block is unreachable. */
const NORETURN_CALLS = new Set([
  'exit', '_exit', '_Exit', 'abort', 'longjmp', 'siglongjmp', '__builtin_unreachable', '__builtin_trap', 'panic',
]);

export function inferPathConditions(fn: FunctionInfo, targetLine: number): string[] {
  const conditions: string[] = [];
  for (const cond of fn.conditions) {
    if (cond.line < targetLine) {
      conditions.push(cond.text.slice(0, 60));
    }
  }
  return conditions;
}

/**
 * Map each line to the branch guards (with polarity) that enclose it, via a
 * guard-tracking walk of the AST. A line inside `if (c) {...}` carries
 * `{condition:'c', negated:false}`; inside the `else`, `negated:true`. Powers
 * path-sensitive free reconciliation (guard-subset).
 */
export function collectLineGuards(
  body: TreeSitterNode,
  lines: string[],
): Map<number, { condition: string; negated: boolean }[]> {
  const map = new Map<number, { condition: string; negated: boolean }[]>();
  const walk = (node: TreeSitterNode, stack: { condition: string; negated: boolean }[]) => {
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
      const condNode = node.childForFieldName?.('condition') ?? findChild(node, 'parenthesized_expression');
      const condText = condNode ? stripParens(nodeText(condNode, lines)) : '';
      const cons = node.childForFieldName?.('consequence');
      const alt = node.childForFieldName?.('alternative') ?? findChild(node, 'else_clause');
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
      const condNode = node.childForFieldName?.('condition') ?? findChild(node, 'parenthesized_expression');
      const sw = condNode ? stripParens(nodeText(condNode, lines)) : '';
      if (condNode) walk(condNode, stack);
      const swBody = node.childForFieldName?.('body') ?? findChild(node, 'compound_statement');
      for (const c of swBody?.children || []) {
        if (c.type !== 'case_statement') {
          walk(c, stack);
          continue;
        }
        const valNode = (c.children || []).find(
          (x: TreeSitterNode) => x.type === 'number_literal' || x.type === 'char_literal' || x.type === 'identifier',
        );
        const guard = sw && valNode ? [...stack, { condition: `${sw} == ${nodeText(valNode, lines)}`, negated: false }] : stack;
        walk(c, guard);
      }
      return;
    }
    for (const child of node.children || []) walk(child, stack);
  };
  walk(body, []);
  return map;
}

/**
 * 1-based lines that are PROVABLY unreachable: a statement after an UNCONDITIONAL
 * terminator (return / goto / exit()/abort()/longjmp()/_Noreturn) at the SAME block
 * level, up to the next `labeled_statement`/`case_statement` (a goto/switch target
 * resets reachability). Conservative on purpose: a terminator inside an if/loop is
 * CONDITIONAL, so it does NOT kill its siblings — meaning we only ever drop code that
 * genuinely cannot run, so an exit-path filtered by this can never hide a real leak.
 */
export function collectDeadLines(body: TreeSitterNode, lines: string[]): Set<number> {
  const dead = new Set<number>();
  const markSubtree = (node: TreeSitterNode) => {
    const ln = (node.startPosition?.row ?? -1) + 1;
    if (ln > 0) dead.add(ln);
    for (const c of node.children || []) markSubtree(c);
  };
  const isTerminator = (stmt: TreeSitterNode): boolean => {
    if (stmt.type === 'return_statement' || stmt.type === 'goto_statement') return true;
    if (stmt.type === 'expression_statement') {
      const call = findAllNodes(stmt, 'call_expression')[0];
      const fnNode = call ? getCallFunctionNameNode(call) : null;
      const name = fnNode ? nodeText(fnNode, lines) : '';
      return NORETURN_CALLS.has(name);
    }
    return false;
  };
  const walk = (node: TreeSitterNode) => {
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

export function analyzeExitPaths(
  body: TreeSitterNode,
  lines: string[],
  fn: FunctionInfo,
): ExitPathAnalysis[] {
  const paths: ExitPathAnalysis[] = [];

  // Per-line branch guards (with polarity) — the conditions enclosing each line.
  const lineGuards = collectLineGuards(body, lines);
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
  const dead = collectDeadLines(body, lines);

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
      pathConditions: inferPathConditions(fn, ret.line),
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
