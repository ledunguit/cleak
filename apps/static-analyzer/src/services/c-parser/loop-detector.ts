import type { TreeSitterNode } from '../../types/tree-sitter';
import type { FunctionInfo, LoopInfo } from './c-parser.types';
import { findAllNodes, findChild, nodeText, getCallFunctionNameNode } from './ast-utils';

// ── LOOP DETECTION ──

export function buildLoopInfo(
  kind: LoopInfo['kind'],
  node: TreeSitterNode,
  body: TreeSitterNode | undefined,
  lines: string[],
  fn: FunctionInfo,
  allocSet: Set<string>,
  freeSet: Set<string>,
): LoopInfo {
  const line = (node.startPosition?.row ?? 0) + 1;
  const text = nodeText(node, lines).slice(0, 80);

  const bodyAllocCalls = body
    ? findAllNodes(body, 'call_expression').filter((c: TreeSitterNode) => {
        const name = nodeText(getCallFunctionNameNode(c), lines);
        return allocSet.has(name);
      })
    : [];

  const bodyFreeCalls = body
    ? findAllNodes(body, 'call_expression').filter((c: TreeSitterNode) => {
        const name = nodeText(getCallFunctionNameNode(c), lines);
        return freeSet.has(name);
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

export function detectLoops(
  body: TreeSitterNode,
  lines: string[],
  fn: FunctionInfo,
  allocSet: Set<string>,
  freeSet: Set<string>,
): LoopInfo[] {
  const loops: LoopInfo[] = [];

  const forNodes = findAllNodes(body, 'for_statement');
  const whileNodes = findAllNodes(body, 'while_statement');
  const doNodes = findAllNodes(body, 'do_statement');

  for (const node of forNodes) {
    const loopBody = findChild(node, 'compound_statement');
    loops.push(buildLoopInfo('for', node, loopBody, lines, fn, allocSet, freeSet));
  }

  for (const node of whileNodes) {
    const loopBody = findChild(node, 'compound_statement');
    loops.push(buildLoopInfo('while', node, loopBody, lines, fn, allocSet, freeSet));
  }

  for (const node of doNodes) {
    const loopBody = findChild(node, 'compound_statement');
    loops.push(buildLoopInfo('do_while', node, loopBody, lines, fn, allocSet, freeSet));
  }

  return loops;
}
