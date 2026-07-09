import type { TreeSitterNode } from '../../types/tree-sitter';

// ── Stateless AST helpers ──

export function findAllNodes(node: TreeSitterNode, targetType: string): TreeSitterNode[] {
  const found: TreeSitterNode[] = [];
  if (node.type === targetType) {
    found.push(node);
  }
  for (const child of node.children || []) {
    found.push(...findAllNodes(child, targetType));
  }
  return found;
}

export function findChild(node: TreeSitterNode, targetType: string): TreeSitterNode | undefined {
  return (node.children || []).find((c: TreeSitterNode) => c.type === targetType);
}

export function findChildren(node: TreeSitterNode, targetType: string): TreeSitterNode[] {
  return (node.children || []).filter((c: TreeSitterNode) => c.type === targetType);
}

export function nodeText(node: TreeSitterNode | null | undefined, lines: string[]): string {
  if (!node || node.startIndex == null) return '';
  const sp = node.startPosition!;
  const ep = node.endPosition!;
  let text = '';
  if (sp.row === ep.row) {
    text = lines[sp.row]?.substring(sp.column, ep.column) || '';
  } else {
    text = lines[sp.row]?.substring(sp.column) || '';
    for (let r = sp.row + 1; r <= ep.row; r++) {
      if (r < lines.length) {
        text += '\n' + (r === ep.row
          ? lines[r].substring(0, ep.column)
          : lines[r]);
      }
    }
  }
  return text.trim();
}

export function getCallFunctionNameNode(expr: TreeSitterNode): TreeSitterNode | null {
  const children = expr.children || [];
  const first = children[0];
  if (!first) return null;

  if (first.type === 'identifier') return first;

  // Handle nested calls like func()() or foo->method()
  if (first.type === 'field_expression') {
    return findChild(first, 'field_identifier') ?? null;
  }
  if (first.type === 'pointer_expression') {
    return findChild(first, 'identifier') ?? null;
  }

  return null;
}

/** Strip fully-enclosing outer parentheses: `((p == NULL))` → `p == NULL`. */
export function stripParens(s: string): string {
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

/** Extract the bare identifier name from an init_declarator node. */
export function extractDeclaratorName(declaratorNode: TreeSitterNode, lines: string[]): string {
  const id = findChild(declaratorNode, 'identifier');
  if (id) return nodeText(id, lines);
  const ptrDecl = findChild(declaratorNode, 'pointer_declarator');
  if (ptrDecl) {
    const ptrId = findChild(ptrDecl, 'identifier');
    if (ptrId) return nodeText(ptrId, lines);
  }
  return '';
}
