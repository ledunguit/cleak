import type { TreeSitterNode } from '../../types/tree-sitter';
import type { GotoTarget } from './c-parser.types';
import { findAllNodes, nodeText } from './ast-utils';

// ── GOTO TARGET DETECTION ──

export function extractGotoLabel(node: TreeSitterNode, lines: string[]): string {
  const children = node.children || [];
  // goto_statement: 'goto' identifier ';'
  const idNode = children.find(
    (c: TreeSitterNode) => c.type === 'identifier',
  );
  return idNode ? nodeText(idNode, lines) : 'unknown';
}

export function findGotoTargets(body: TreeSitterNode, lines: string[]): GotoTarget[] {
  const targets: GotoTarget[] = [];

  const gotoNodes = findAllNodes(body, 'goto_statement');
  const labelNodes = findAllNodes(body, 'labeled_statement');

  for (const g of gotoNodes) {
    const labelName = extractGotoLabel(g, lines);
    const labelNode = labelNodes.find((l: TreeSitterNode) => {
      const name = nodeText(l.children?.[0], lines);
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
