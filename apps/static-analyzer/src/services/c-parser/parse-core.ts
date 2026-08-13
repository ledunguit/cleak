/**
 * Pure tree-sitter parse logic, deliberately free of NestJS/DI and mutable
 * instance state so it can run identically on the main thread (in-process
 * fallback) or inside a `worker_threads` worker (see
 * `apps/static-analyzer/src/workers/parse.worker.ts`). `allocSet`/`freeSet`
 * are passed as plain arguments rather than read off `this` — the old
 * `CParserService` set them as instance fields right before a synchronous
 * call, which only worked because nothing awaited in between; once parsing
 * moves off-thread (or even just becomes `async`), concurrent calls with
 * different allocator lists would race on shared mutable state.
 */

import type { TreeSitterParser } from '../../types/tree-sitter';
import { findAllNodes, findChild } from './ast-utils';
import { buildFunctionInfo } from './function-info-extractor';
import { buildControlFlowGraph } from './cfg-builder';
import { analyzeExitPaths } from './exit-path-analyzer';
import { detectLoops } from './loop-detector';
import { findGotoTargets } from './goto-analyzer';
import type { ParseResult, FunctionInfo } from './c-parser.types';

/** Build a fresh, language-bound tree-sitter parser. Callers keep it around
 * (main-thread singleton or per-worker singleton) — construction is the
 * expensive part, `.parse()` calls on an existing instance are cheap. */
export function createParser(cpp: boolean): TreeSitterParser {
  // tree-sitter's native addons are CommonJS-only — dynamic `require` is the
  // only way to load them from this ESM package, so this is intentional.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Parser = require('tree-sitter');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const lang = require(cpp ? 'tree-sitter-cpp' : 'tree-sitter-c');
  const p = new Parser();
  p.setLanguage(lang);
  return p;
}

/** Parse `content` and extract per-function leak-analysis info. Throws on
 * tree-sitter failure — callers decide how to degrade (log + empty result). */
export function runParse(
  parser: TreeSitterParser,
  content: string,
  allocSet: Set<string>,
  freeSet: Set<string>,
): ParseResult {
  const tree = parser.parse(content);
  const root = tree.rootNode;
  const lines = content.split('\n');

  const funcNodes = findAllNodes(root, 'function_definition');
  const functions: FunctionInfo[] = [];

  for (const funcNode of funcNodes) {
    const info = buildFunctionInfo(funcNode, lines, allocSet, freeSet);
    if (info) {
      const body = findChild(funcNode, 'compound_statement');
      if (body) {
        info.controlFlow = buildControlFlowGraph(body, lines, info, allocSet, freeSet);
        info.exitPaths = analyzeExitPaths(body, lines, info);
        info.loops = detectLoops(body, lines, info, allocSet, freeSet);
        info.gotoTargets = findGotoTargets(body, lines);
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
}
