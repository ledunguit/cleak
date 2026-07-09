import type { TreeSitterNode } from '../../types/tree-sitter';
import type { FunctionInfo, ControlFlowGraph, ControlFlowNode, ControlFlowEdge } from './c-parser.types';
import { findAllNodes, findChild, nodeText, getCallFunctionNameNode, extractDeclaratorName } from './ast-utils';
import { extractGotoLabel } from './goto-analyzer';

// ── CONTROL FLOW GRAPH CONSTRUCTION ──

function walkStatements(
  parent: TreeSitterNode,
  nodes: ControlFlowNode[],
  edges: ControlFlowEdge[],
  lines: string[],
  nextId: number,
  exitId: number,
  allocVarNames: Set<string>,
  freeVarNames: Set<string>,
  fn: FunctionInfo,
  allocSet: Set<string>,
  freeSet: Set<string>,
): number {
  let id = nextId;
  const stmts = parent.children || [];

  for (const stmt of stmts) {
    if (!stmt.type || stmt.type === '}') continue;

    switch (stmt.type) {
      case 'if_statement': {
        const cond = findChild(stmt, 'parenthesized_expression');
        const condText = cond ? nodeText(cond, lines) : '';

        // Condition node
        const condId = id++;
        const thenBody = findChild(stmt, 'compound_statement');
        const elseBody = findChild(stmt, 'else_clause');

        nodes.push({
          id: condId, type: 'condition', line: (stmt.startPosition?.row ?? 0) + 1,
          text: `if (${condText})`, hasFree: false,
          hasAllocation: false, allocationVars: [],
        });

        // Then branch
        const thenStartId = id;
        if (thenBody) {
          id = walkStatements(thenBody, nodes, edges, lines, id, exitId, allocVarNames, freeVarNames, fn, allocSet, freeSet);
        }
        const thenEndId = id;
        edges.push({ from: condId, to: thenStartId, condition: condText, isTrueBranch: true });

        // Create a merge node after the then branch (if no else)
        const mergeId = id++;

        // Else branch
        if (elseBody) {
          const elseCompound = findChild(elseBody, 'compound_statement');
          const elseStartId = id;
          if (elseCompound) {
            id = walkStatements(elseCompound, nodes, edges, lines, id, exitId, allocVarNames, freeVarNames, fn, allocSet, freeSet);
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
        const loopText = nodeText(stmt, lines).slice(0, 80);

        // Loop header node
        const loopId = id++;
        const loopBody = findChild(stmt, 'compound_statement');
        const bodyText = loopBody ? nodeText(loopBody, lines).slice(0, 80) : '';

        nodes.push({
          id: loopId, type: 'loop', line: (stmt.startPosition?.row ?? 0) + 1,
          text: loopText || bodyText, hasFree: false,
          hasAllocation: false, allocationVars: [],
        });

        // Loop body
        const bodyStartId = id;
        if (loopBody) {
          id = walkStatements(loopBody, nodes, edges, lines, id, exitId, allocVarNames, freeVarNames, fn, allocSet, freeSet);
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
        const retText = nodeText(stmt, lines).slice(0, 60);
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
        const label = extractGotoLabel(stmt, lines);
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
        const labelName = nodeText(stmt.children?.[0], lines) || '';
        const innerBody = findChild(stmt, 'compound_statement');
        nodes.push({
          id: labelId, type: 'label', line: (stmt.startPosition?.row ?? 0) + 1,
          text: `${labelName}:`, hasFree: false,
          hasAllocation: false, allocationVars: [],
        });
        if (innerBody) {
          id = walkStatements(innerBody, nodes, edges, lines, id, exitId, allocVarNames, freeVarNames, fn, allocSet, freeSet);
        }
        break;
      }

      case 'compound_statement': {
        id = walkStatements(stmt, nodes, edges, lines, id, exitId, allocVarNames, freeVarNames, fn, allocSet, freeSet);
        break;
      }

      case 'expression_statement':
      case 'declaration': {
        const stmtText = nodeText(stmt, lines).slice(0, 80);
        // Walk the AST (not regex on truncated text, which misreads `log(x); free(p);`
        // and casts/subscripts) — `free()` at ANY position counts; an allocator call on
        // an assignment RHS sets hasAllocation + captures the LHS var.
        let hasFree = false;
        let hasAlloc = false;
        const allocVars: string[] = [];
        for (const call of findAllNodes(stmt, 'call_expression')) {
          const name = nodeText(getCallFunctionNameNode(call), lines);
          if (freeSet.has(name)) hasFree = true;
          if (allocSet.has(name)) hasAlloc = true;
        }
        // C++ `new T(...)` is an allocation too (not a call_expression).
        if (findAllNodes(stmt, 'new_expression').length > 0) hasAlloc = true;
        if (hasAlloc) {
          // The LHS variable of `var = [cast] alloc(...)` / `T* var = new T()`.
          const decl = findChild(stmt, 'init_declarator');
          const assign = findAllNodes(stmt, 'assignment_expression')[0];
          const lhs = decl ? extractDeclaratorName(decl, lines) : assign?.children?.[0] ? nodeText(assign.children[0], lines) : '';
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

export function buildControlFlowGraph(
  body: TreeSitterNode,
  lines: string[],
  fn: FunctionInfo,
  allocSet: Set<string>,
  freeSet: Set<string>,
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

  const lastBlockId = walkStatements(body, nodes, edges, lines, nodeId, exitId, allocVarNames, freeVarNames, fn, allocSet, freeSet);
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
