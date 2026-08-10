/**
 * Piscina task worker — runs tree-sitter parsing off the main thread. Each
 * worker keeps its own lazily-built parser instances (mirrors
 * `CParserService.getParser()`'s main-thread lazy-init) so repeated tasks on
 * the same worker reuse them instead of reconstructing per call.
 */

import { ALLOCATION_FUNCTIONS, DEALLOCATION_FUNCTIONS } from '@cleak/common/constants/allocators';
import type { TreeSitterParser } from '../types/tree-sitter';
import { createParser, runParse } from '../services/c-parser/parse-core';
import type { ParseResult } from '../services/c-parser/c-parser.types';

export interface ParseTask {
  content: string;
  cpp: boolean;
  extraAllocators: string[];
  extraDeallocators: string[];
}

let parser: TreeSitterParser | null = null;
let cppParser: TreeSitterParser | null = null;

function getParser(cpp: boolean): TreeSitterParser {
  if (cpp) return (cppParser ??= createParser(true));
  return (parser ??= createParser(false));
}

export default function parseTask(task: ParseTask): ParseResult {
  const { content, cpp, extraAllocators, extraDeallocators } = task;
  const allocSet = extraAllocators.length ? new Set([...ALLOCATION_FUNCTIONS, ...extraAllocators]) : ALLOCATION_FUNCTIONS;
  const freeSet = extraDeallocators.length ? new Set([...DEALLOCATION_FUNCTIONS, ...extraDeallocators]) : DEALLOCATION_FUNCTIONS;
  try {
    return runParse(getParser(cpp), content, allocSet, freeSet);
  } catch {
    return { functions: [], functionNames: [] };
  }
}
