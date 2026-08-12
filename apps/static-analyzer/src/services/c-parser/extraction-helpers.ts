import type { TreeSitterNode } from '../../types/tree-sitter';
import { findAllNodes, findChild, findChildren, nodeText, getCallFunctionNameNode, getCallReceiverNode, extractDeclaratorName } from './ast-utils';

export function extractFunctionName(node: TreeSitterNode, lines: string[]): string {
  const declarator = findChild(node, 'function_declarator') ||
                     findChild(node, 'pointer_declarator');
  if (!declarator) return 'unknown';

  // `Foo::~Foo(){}` — tree-sitter-cpp's `destructor_name` wraps `~` + an
  // `identifier` matching the class name. Checked BEFORE the generic
  // identifier fallbacks below: those would otherwise pick up the SAME bare
  // `identifier` a same-class constructor extracts to, colliding ctor and
  // dtor onto one `fnIndex` entry (the same collision class as virtual
  // dispatch's same-named-method-across-classes problem).
  const dtorNode = findAllNodes(declarator, 'destructor_name')[0];
  if (dtorNode) return nodeText(dtorNode, lines);

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

/**
 * Class membership for an OUT-OF-CLASS method definition (`ClassName::method(){}`)
 * — the shape Juliet's C++ CWE-401 variants actually use (virtual dispatch 81-82,
 * RAII ctor/dtor 83-84). `extractFunctionName`'s fallback already returns the bare
 * method name correctly (it walks past `qualified_identifier`'s `namespace_identifier`
 * child, which is a different node TYPE than `identifier`) — this is the missing
 * other half: the class name itself, needed so `fnIndex` can disambiguate same-named
 * methods across different classes instead of colliding on the bare name.
 * Deliberately scoped to `ClassName::method` — does NOT resolve class membership for
 * a method defined INLINE inside `class Foo { void method() {...} };` (a different
 * AST shape, no `qualified_identifier`); Juliet's corpus doesn't use that shape for
 * this CWE, so it's out of scope rather than guessed at.
 */
export function extractClassMembership(node: TreeSitterNode, lines: string[]): { className?: string; memberKind?: 'ctor' | 'dtor' } {
  const topDecl = findChild(node, 'function_declarator') || findChild(node, 'pointer_declarator');
  if (!topDecl) return {};
  const funcDecl = topDecl.type === 'function_declarator' ? topDecl : findChild(topDecl, 'function_declarator');
  const qualified = funcDecl ? findChild(funcDecl, 'qualified_identifier') : undefined;
  if (!qualified) return {};
  const nsId = findChild(qualified, 'namespace_identifier');
  if (!nsId) return {};
  const className = nodeText(nsId, lines);
  if (findChild(qualified, 'destructor_name')) return { className, memberKind: 'dtor' };
  const idNode = findChild(qualified, 'identifier');
  if (idNode && nodeText(idNode, lines) === className) return { className, memberKind: 'ctor' };
  return { className };
}

export function extractParameters(
  node: TreeSitterNode,
  lines: string[],
): { name: string; type: string; isPointer: boolean }[] {
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
      return { name, type, isPointer };
    });
}

/** Storage-class specifier on a function DEFINITION — `static` means internal linkage:
 * a harness in a separate translation unit cannot declare-and-link this function, it
 * must #include the defining source file instead. */
export function extractStorageClass(node: TreeSitterNode, lines: string[]): 'static' | 'extern' | 'none' {
  const spec = findChild(node, 'storage_class_specifier');
  if (!spec) return 'none';
  const text = nodeText(spec, lines);
  return text === 'static' ? 'static' : text === 'extern' ? 'extern' : 'none';
}

/** The function's return type, including a trailing ` *` when the declarator chain
 * (before reaching the function_declarator) is a pointer_declarator. */
export function extractReturnType(node: TreeSitterNode, lines: string[]): string {
  const typeNode = (node.children || []).find((c: TreeSitterNode) =>
    ['primitive_type', 'type_identifier', 'sized_type_specifier', 'struct_specifier'].includes(c.type),
  );
  const typeText = typeNode ? nodeText(typeNode, lines) : 'int';
  const topDecl = (node.children || []).find(
    (c: TreeSitterNode) => c.type === 'function_declarator' || c.type === 'pointer_declarator',
  );
  const isPointerReturn = topDecl?.type === 'pointer_declarator';
  return typeText + (isPointerReturn ? ' *' : '');
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

/** Positional argument identifiers of a call, e.g. `badSink(data)` → `['data']`,
 * `f(p->x, 1)` → `[null, null]`. Only bare identifiers are resolved. */
export function extractCallArgs(expr: TreeSitterNode, lines: string[]): (string | null)[] {
  const argList = findChild(expr, 'argument_list');
  if (!argList) return [];
  return (argList.children || [])
    .filter((c: TreeSitterNode) => c.type !== '(' && c.type !== ')' && c.type !== ',')
    .map((c: TreeSitterNode) => (c.type === 'identifier' ? nodeText(c, lines) : null));
}

export function extractFunctionCalls(
  body: TreeSitterNode,
  lines: string[],
): { name: string; line: number; args: (string | null)[]; receiver?: string }[] {
  const calls: { name: string; line: number; args: (string | null)[]; receiver?: string }[] = [];
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

    // The object before `.`/`->` for a method call (`obj.action()`/`obj->action()`) —
    // needed to resolve WHICH class's `action` this is (see `extractConstructedTypes`).
    // Null for a plain function call.
    const receiverNode = getCallReceiverNode(expr);
    const receiver = receiverNode ? nodeText(receiverNode, lines) : undefined;

    calls.push({ name, line: (expr.startPosition?.row ?? 0) + 1, args: extractCallArgs(expr, lines), ...(receiver ? { receiver } : {}) });
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
