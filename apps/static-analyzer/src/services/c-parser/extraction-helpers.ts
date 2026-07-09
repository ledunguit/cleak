import type { TreeSitterNode } from '../../types/tree-sitter';
import { findAllNodes, findChild, findChildren, nodeText, getCallFunctionNameNode, extractDeclaratorName } from './ast-utils';

export function extractFunctionName(node: TreeSitterNode, lines: string[]): string {
  const declarator = findChild(node, 'function_declarator') ||
                     findChild(node, 'pointer_declarator');
  if (!declarator) return 'unknown';

  const directId = findChild(declarator, 'identifier');
  if (directId) return nodeText(directId, lines);

  const innerFuncDecl = findChild(declarator, 'function_declarator');
  if (innerFuncDecl) {
    const innerId = findChild(innerFuncDecl, 'identifier');
    if (innerId) return nodeText(innerId, lines);
  }

  const innerPtrDecl = findChild(declarator, 'pointer_declarator');
  if (innerPtrDecl) {
    const chainId = findChild(innerPtrDecl, 'identifier');
    if (chainId) return nodeText(chainId, lines);
    const chainFunc = findChild(innerPtrDecl, 'function_declarator');
    if (chainFunc) {
      const chainFuncId = findChild(chainFunc, 'identifier');
      if (chainFuncId) return nodeText(chainFuncId, lines);
    }
  }

  const allIds = findAllNodes(declarator, 'identifier');
  if (allIds.length > 0) return nodeText(allIds[0], lines);

  return 'unknown';
}

export function extractParameters(node: TreeSitterNode, lines: string[]): { name: string; type: string }[] {
  const topDecl = (node.children || []).find(
    (c: TreeSitterNode) => c.type === 'function_declarator' || c.type === 'pointer_declarator',
  );
  if (!topDecl) return [];
  const funcDecl =
    topDecl.type === 'function_declarator' ? topDecl : findAllNodes(topDecl, 'function_declarator')[0];
  const paramList = funcDecl ? findChild(funcDecl, 'parameter_list') : undefined;
  if (!paramList) return [];

  return (paramList.children || [])
    .filter((c: TreeSitterNode) => c.type === 'parameter_declaration')
    .map((param: TreeSitterNode) => {
      const typeNames = (param.children || [])
        .filter((c: TreeSitterNode) =>
          ['primitive_type', 'type_identifier', 'sized_type_specifier', 'struct_specifier'].includes(c.type),
        )
        .map((c: TreeSitterNode) => nodeText(c, lines));
      const declaratorChild = param.children?.find(
        (c: TreeSitterNode) => c.type === 'identifier' ||
          c.type === 'pointer_declarator' ||
          c.type === 'array_declarator',
      );
      const isPointer =
        declaratorChild?.type === 'pointer_declarator' || declaratorChild?.type === 'array_declarator';
      let name = '';
      if (declaratorChild) {
        if (isPointer) {
          const id = findAllNodes(declaratorChild, 'identifier')[0];
          name = id ? nodeText(id, lines) : nodeText(declaratorChild, lines).replace(/[*[\]\s]/g, '');
        } else {
          name = nodeText(declaratorChild, lines);
        }
      }
      const type = (typeNames.join(' ') || 'int') + (isPointer ? ' *' : '');
      return { name, type };
    });
}

export function extractLocalVariables(node: TreeSitterNode, lines: string[]): { name: string; type: string }[] {
  const body = findChild(node, 'compound_statement');
  if (!body) return [];

  const result: { name: string; type: string }[] = [];
  const decls = findAllNodes(body, 'declaration');

  for (const decl of decls) {
    const typeNode = (decl.children || []).find(
      (c: TreeSitterNode) =>
        ['primitive_type', 'type_identifier', 'sized_type_specifier', 'struct_specifier'].includes(c.type),
    );
    const typeText = typeNode ? nodeText(typeNode, lines) : 'int';
    const initDecls = findChildren(decl, 'init_declarator');

    for (const initDecl of initDecls) {
      const name = extractDeclaratorName(initDecl, lines);
      if (name) result.push({ name, type: typeText });
    }
  }

  return result;
}

export function extractFunctionCalls(body: TreeSitterNode, lines: string[]): { name: string; line: number }[] {
  const calls: { name: string; line: number }[] = [];
  const callExprs = findAllNodes(body, 'call_expression');
  const visited = new Set<string>();

  for (const expr of callExprs) {
    const fnNode = getCallFunctionNameNode(expr);
    if (!fnNode) continue;
    const name = nodeText(fnNode, lines);
    if (!name) continue;

    const key = `${name}:${(expr.startPosition?.row ?? 0) + 1}`;
    if (visited.has(key)) continue;
    visited.add(key);

    calls.push({ name, line: (expr.startPosition?.row ?? 0) + 1 });
  }

  return calls;
}

export function isAllocationCall(node: TreeSitterNode, lines: string[], allocSet: Set<string>): boolean {
  const callExprs = findAllNodes(node, 'call_expression');
  for (const expr of callExprs) {
    const fnNode = getCallFunctionNameNode(expr);
    if (fnNode && allocSet.has(nodeText(fnNode, lines))) {
      return true;
    }
  }
  return false;
}

export function extractReturnStatements(node: TreeSitterNode, lines: string[]): { line: number; text: string }[] {
  const body = findChild(node, 'compound_statement');
  if (!body) return [];
  return findAllNodes(body, 'return_statement').map((ret) => ({
    line: (ret.startPosition?.row ?? 0) + 1,
    text: nodeText(ret, lines),
  }));
}

export function extractConditions(node: TreeSitterNode, lines: string[]): { line: number; text: string }[] {
  const body = findChild(node, 'compound_statement');
  if (!body) return [];
  return findAllNodes(body, 'if_statement').map((ifStmt) => ({
    line: (ifStmt.startPosition?.row ?? 0) + 1,
    text: nodeText(ifStmt, lines),
  }));
}
