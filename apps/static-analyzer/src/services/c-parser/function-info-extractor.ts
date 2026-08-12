import type { TreeSitterNode } from '../../types/tree-sitter';
import type { FunctionInfo } from './c-parser.types';
import {
  findAllNodes, findChild, nodeText, getCallFunctionNameNode, getCallReceiverNode, extractDeclaratorName,
} from './ast-utils';
import {
  extractFunctionName, extractParameters, extractLocalVariables,
  extractFunctionCalls, isAllocationCall, extractReturnStatements, extractConditions,
  extractStorageClass, extractReturnType, extractCallArgs, extractClassMembership,
} from './extraction-helpers';

// Deliberately closed, STL-specific method sets — narrow by design, same
// "evidence-gated, no whole-program alias analysis" philosophy as the rest of
// this file. `emplace_*` omitted: not observed anywhere in the corpus this
// was built against; add if a real case needs it.
const CONTAINER_INSERT_METHODS = new Set(['insert', 'push_back', 'push_front']);
const CONTAINER_EXTRACT_METHODS = new Set(['front', 'back', 'at']);

/** A heap-allocated variable inserted into a container: `dataVector.insert(...,
 * data)`, `dataList.push_back(data)` (call-shaped), or `dataMap[0] = data`
 * (subscript-assignment-shaped, map style). The container's identity — not the
 * original variable's — is what survives into a cross-function call argument. */
function extractContainerCarriers(
  node: TreeSitterNode,
  lines: string[],
): { container: string; variable: string; line: number }[] {
  const body = findChild(node, 'compound_statement');
  if (!body) return [];
  const result: { container: string; variable: string; line: number }[] = [];

  for (const expr of findAllNodes(body, 'call_expression')) {
    const fnNode = getCallFunctionNameNode(expr);
    const name = fnNode ? nodeText(fnNode, lines) : '';
    if (!CONTAINER_INSERT_METHODS.has(name)) continue;
    const receiver = getCallReceiverNode(expr);
    if (!receiver) continue;
    const container = nodeText(receiver, lines);
    for (const arg of extractCallArgs(expr, lines)) {
      if (arg) result.push({ container, variable: arg, line: (expr.startPosition?.row ?? 0) + 1 });
    }
  }

  for (const expr of findAllNodes(body, 'assignment_expression')) {
    const left = expr.children?.[0];
    const right = expr.children?.[expr.children.length - 1];
    if (!left || !right || left.type !== 'subscript_expression' || right.type !== 'identifier') continue;
    const base = left.children?.[0];
    if (!base || base.type !== 'identifier') continue;
    result.push({ container: nodeText(base, lines), variable: nodeText(right, lines), line: (left.startPosition?.row ?? 0) + 1 });
  }

  return result;
}

/** A local variable pulled back OUT of a container: `char *data = dataVector[2];`
 * (subscript-shaped) or `char *data = dataList.front()/.back()/.at(i);`
 * (call-shaped). Ties a container-typed parameter to the local pointer variable
 * that then needs the usual leak check. */
function extractContainerExtractions(
  node: TreeSitterNode,
  lines: string[],
): { variable: string; container: string; line: number }[] {
  const body = findChild(node, 'compound_statement');
  if (!body) return [];
  const result: { variable: string; container: string; line: number }[] = [];

  for (const decl of findAllNodes(body, 'init_declarator')) {
    const value = decl.children?.[decl.children.length - 1];
    if (!value) continue;
    if (value.type === 'subscript_expression') {
      const base = value.children?.[0];
      if (base?.type !== 'identifier') continue;
      const varName = extractDeclaratorName(decl, lines);
      if (varName) result.push({ variable: varName, container: nodeText(base, lines), line: (decl.startPosition?.row ?? 0) + 1 });
    } else if (value.type === 'call_expression') {
      const fnNode = getCallFunctionNameNode(value);
      const name = fnNode ? nodeText(fnNode, lines) : '';
      if (!CONTAINER_EXTRACT_METHODS.has(name)) continue;
      const receiver = getCallReceiverNode(value);
      if (!receiver) continue;
      const varName = extractDeclaratorName(decl, lines);
      if (varName) result.push({ variable: varName, container: nodeText(receiver, lines), line: (decl.startPosition?.row ?? 0) + 1 });
    }
  }

  return result;
}

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

/**
 * `Base* obj = new Derived;` / `obj = new Derived(args);` — the DECLARED type
 * (`Base`, from `localVariables`) is NOT what should resolve a later
 * `obj->method()` call: Juliet's virtual-dispatch shape (flow-variant 81-82)
 * constructs the DERIVED class through a base-class-typed pointer specifically
 * to exercise dispatch. `new_expression`'s own `type_identifier` child names
 * the class actually constructed — that's what `call-graph.service.ts` needs to
 * resolve `obj->action()` to the right class's `Class::action` in `fnIndex`,
 * instead of colliding on the bare method name across every class that defines
 * one (see `extractClassMembership`'s doc comment for the fnIndex side).
 */
function extractConstructedTypes(node: TreeSitterNode, lines: string[]): { variable: string; className: string; line: number }[] {
  const body = findChild(node, 'compound_statement');
  if (!body) return [];
  const result: { variable: string; className: string; line: number }[] = [];

  for (const decl of findAllNodes(body, 'init_declarator')) {
    const newExpr = findChild(decl, 'new_expression');
    if (!newExpr) continue;
    const typeId = findChild(newExpr, 'type_identifier');
    const varName = extractDeclaratorName(decl, lines);
    if (typeId && varName) result.push({ variable: varName, className: nodeText(typeId, lines), line: (decl.startPosition?.row ?? 0) + 1 });
  }

  for (const expr of findAllNodes(body, 'assignment_expression')) {
    const left = expr.children?.[0];
    const right = expr.children?.[expr.children.length - 1];
    if (!left || !right) continue;
    const newExpr = right.type === 'new_expression' ? right : findChild(right, 'new_expression');
    if (!newExpr) continue;
    const typeId = findChild(newExpr, 'type_identifier');
    if (typeId && left.type === 'identifier') {
      result.push({ variable: nodeText(left, lines), className: nodeText(typeId, lines), line: (left.startPosition?.row ?? 0) + 1 });
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
    const containerCarriers = extractContainerCarriers(funcNode, lines);
    const containerExtractions = extractContainerExtractions(funcNode, lines);
    const { className, memberKind } = extractClassMembership(funcNode, lines);
    const constructedTypes = extractConstructedTypes(funcNode, lines);

    const fn: FunctionInfo = {
      functionName,
      className,
      memberKind,
      constructedTypes,
      parameters,
      localVariables,
      returnType: extractReturnType(funcNode, lines),
      storageClass: extractStorageClass(funcNode, lines),
      functionCalls,
      allocationCalls,
      deallocationCalls,
      returnStatements,
      conditions,
      allocationVariables,
      freedVariables,
      assignedCalls,
      containerCarriers,
      containerExtractions,
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
