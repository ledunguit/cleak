import type { TreeSitterNode } from '../../types/tree-sitter';
import type { FunctionInfo } from './c-parser.types';
import { findAllNodes, findChild, nodeText, getCallFunctionNameNode, extractDeclaratorName } from './ast-utils';
import {
  extractFunctionName, extractParameters, extractLocalVariables,
  extractFunctionCalls, isAllocationCall, extractReturnStatements, extractConditions,
} from './extraction-helpers';

function extractAllocationVariables(
  node: TreeSitterNode,
  lines: string[],
  allocationCalls: { name: string; line: number }[],
  allocSet: Set<string>,
): { variable: string; line: number; callName: string }[] {
  const body = findChild(node, 'compound_statement');
  if (!body) return [];

  const result: { variable: string; line: number; callName: string }[] = [];

  // Track variables that receive allocation results
  // Pattern: type *var = malloc(...) or var = malloc(...)
  const allInitDecls = findAllNodes(body, 'init_declarator');
  for (const decl of allInitDecls) {
    const callExprs = findAllNodes(decl, 'call_expression');
    let matched = false;
    for (const expr of callExprs) {
      const fnNode = getCallFunctionNameNode(expr);
      const name = fnNode ? nodeText(fnNode, lines) : '';
      if (allocSet.has(name)) {
        const varName = extractDeclaratorName(decl, lines);
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
    if (!matched && findAllNodes(decl, 'new_expression').length > 0) {
      const varName = extractDeclaratorName(decl, lines);
      if (varName) result.push({ variable: varName, line: (decl.startPosition?.row ?? 0) + 1, callName: 'new' });
    }
  }

  // Track struct field allocations: p->field = malloc(...) or s.field = malloc(...)
  const allAssignments = findAllNodes(body, 'assignment_expression');
  for (const expr of allAssignments) {
    const right = expr.children?.[expr.children.length - 1];
    if (right) {
      const left = expr.children?.[0];
      const callExprs = findAllNodes(right, 'call_expression');
      let matched = false;
      for (const callExpr of callExprs) {
        const fnNode = getCallFunctionNameNode(callExpr);
        const name = fnNode ? nodeText(fnNode, lines) : '';
        if (allocSet.has(name)) {
          if (left) {
            const fieldText = nodeText(left, lines);
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
      if (!matched && left && findAllNodes(right, 'new_expression').length > 0) {
        result.push({ variable: nodeText(left, lines), line: (left.startPosition?.row ?? 0) + 1, callName: 'new' });
      }
    }
  }

  return result;
}

function extractFreedVariables(
  node: TreeSitterNode,
  lines: string[],
  deallocCalls: { name: string; line: number }[],
  freeSet: Set<string>,
): { variable: string; line: number }[] {
  const body = findChild(node, 'compound_statement');
  if (!body) return [];
  const result: { variable: string; line: number }[] = [];
  const allExprs = findAllNodes(body, 'call_expression');

  for (const call of deallocCalls) {
    const expr = allExprs.find(
      (e: TreeSitterNode) => (e.startPosition?.row ?? 0) + 1 === call.line,
    );
    if (!expr) continue;
    const args = expr.children?.find((c: TreeSitterNode) => c.type === 'argument_list');
    // argument_list children are `( arg0 , arg1 )` — children[0] is the OPENING PAREN,
    // not the argument. Take the first real argument so `free(p)` records `p`.
    const firstArg = args?.children?.find(
      (c: TreeSitterNode) => c.type !== '(' && c.type !== ')' && c.type !== ',',
    );
    if (firstArg) {
      const varName = nodeText(firstArg, lines);
      result.push({ variable: varName, line: call.line });
    }
  }

  // C++ `delete p;` / `delete[] p;` — a delete_expression, not a call. The operand is
  // the last child (the identifier being deleted).
  for (const del of findAllNodes(body, 'delete_expression')) {
    const operand = (del.children || []).filter((c: TreeSitterNode) => c.type === 'identifier' || c.type === 'field_expression' || c.type === 'subscript_expression').pop();
    if (operand) result.push({ variable: nodeText(operand, lines), line: (del.startPosition?.row ?? 0) + 1 });
  }

  return result;
}

function extractAssignedCalls(
  node: TreeSitterNode,
  lines: string[],
  allocSet: Set<string>,
): { variable: string; line: number; callName: string }[] {
  const body = findChild(node, 'compound_statement');
  if (!body) return [];

  const result: { variable: string; line: number; callName: string }[] = [];

  const initDecls = findAllNodes(body, 'init_declarator');
  for (const decl of initDecls) {
    const callExprs = findAllNodes(decl, 'call_expression');
    if (callExprs.length > 0 && !isAllocationCall(decl, lines, allocSet)) {
      const varName = extractDeclaratorName(decl, lines);
      if (varName) {
        const fnNode = getCallFunctionNameNode(callExprs[0]);
        const callName = fnNode ? nodeText(fnNode, lines) : '';
        result.push({ variable: varName, line: (decl.startPosition?.row ?? 0) + 1, callName });
      }
    }
  }

  const assignExprs = findAllNodes(body, 'assignment_expression');
  for (const expr of assignExprs) {
    const right = expr.children?.[expr.children.length - 1];
    if (right) {
      const callExprs = findAllNodes(right, 'call_expression');
      if (callExprs.length > 0 && !isAllocationCall(right, lines, allocSet)) {
        const left = expr.children?.[0];
        const varName = left ? nodeText(left, lines) : '';
        if (varName) {
          const fnNode = getCallFunctionNameNode(callExprs[0]);
          const callName = fnNode ? nodeText(fnNode, lines) : '';
          result.push({ variable: varName, line: (left?.startPosition?.row ?? 0) + 1, callName });
        }
      }
    }
  }

  return result;
}

export function buildFunctionInfo(
  funcNode: TreeSitterNode,
  lines: string[],
  allocSet: Set<string>,
  freeSet: Set<string>,
): FunctionInfo | null {
  try {
    const body = findChild(funcNode, 'compound_statement');
    if (!body) return null;

    const functionName = extractFunctionName(funcNode, lines);
    const parameters = extractParameters(funcNode, lines);
    const localVariables = extractLocalVariables(funcNode, lines);
    const functionCalls = extractFunctionCalls(body, lines);
    // Use the per-parse sets so project allocators/deallocators (e.g. cJSON_Delete,
    // cJSON_Duplicate) — supplied via parse(...extraAllocators/extraDeallocators) —
    // are recognized here, not just the built-in libc names.
    const allocationCalls = functionCalls.filter((c) => allocSet.has(c.name));
    const deallocationCalls = functionCalls.filter((c) => freeSet.has(c.name));
    const returnStatements = extractReturnStatements(funcNode, lines);
    const conditions = extractConditions(funcNode, lines);
    const allocationVariables = extractAllocationVariables(funcNode, lines, allocationCalls, allocSet);
    const freedVariables = extractFreedVariables(funcNode, lines, deallocationCalls, freeSet);
    const assignedCalls = extractAssignedCalls(funcNode, lines, allocSet);

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
