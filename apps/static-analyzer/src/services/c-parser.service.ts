import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TreeSitterParser } from '../types/tree-sitter';
import { ALLOCATION_FUNCTIONS, DEALLOCATION_FUNCTIONS } from '@cleak/common/constants/allocators';
import { findAllNodes, findChild } from './c-parser/ast-utils';
import { buildFunctionInfo } from './c-parser/function-info-extractor';
import { buildControlFlowGraph } from './c-parser/cfg-builder';
import { analyzeExitPaths } from './c-parser/exit-path-analyzer';
import { detectLoops } from './c-parser/loop-detector';
import { findGotoTargets } from './c-parser/goto-analyzer';
import type { ParseResult, FunctionInfo } from './c-parser/c-parser.types';

// Re-export types for consumers
export type {
  FunctionInfo,
  ControlFlowNode,
  ControlFlowEdge,
  ControlFlowGraph,
  ExitPathAnalysis,
  LoopInfo,
  GotoTarget,
  ParseResult,
} from './c-parser/c-parser.types';

@Injectable()
export class CParserService {
  private readonly logger = new Logger(CParserService.name);

  /** Lazily-built, reused tree-sitter parsers (C and C++), instantiated on first use. */
  private parser: TreeSitterParser | null = null;
  private cppParser: TreeSitterParser | null = null;
  /**
   * Parse-result cache keyed by content hash. The same file is parsed by several
   * tools (candidate-scan → ast-scan → function-summary); parsing is a pure
   * function of content, so we memoize it. Treat results as READ-ONLY — they are
   * shared across callers. Bounded LRU so a huge repo can't grow it without limit.
   */
  private readonly cache = new Map<string, ParseResult>();
  private static readonly CACHE_MAX = 512;

  /** True for C++ source/header extensions — they must be parsed by tree-sitter-cpp, not
   * tree-sitter-c (which misparses `new`/`delete`/templates/`::`/range-for). */
  static isCppPath(filePath?: string): boolean {
    return /\.(cc|cpp|cxx|c\+\+|hpp|hxx|hh|ipp|tcc|inl)$/i.test(filePath || '');
  }

  private getParser(cpp = false): TreeSitterParser {
    if (cpp) {
      if (!this.cppParser) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Parser = require('tree-sitter');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const CPP = require('tree-sitter-cpp');
        const p = new Parser();
        p.setLanguage(CPP);
        this.cppParser = p;
      }
      return this.cppParser!;
    }
    if (!this.parser) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Parser = require('tree-sitter');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const C = require('tree-sitter-c');
      const p = new Parser();
      p.setLanguage(C);
        this.parser = p;
    }
    return this.parser!;
  }

  // Active allocator/deallocator name sets for the CURRENT (synchronous) parse.
  // Default to the built-in libc sets; `parse()` overlays per-project names (≈ LAMeD
  // AllocSource/FreeSink) so factory allocators like cJSON_Duplicate are tracked by
  // the alloc→free pairing and exit-path leak analysis (not just candidate-scan).
  private allocSet: Set<string> = ALLOCATION_FUNCTIONS;
  private freeSet: Set<string> = DEALLOCATION_FUNCTIONS;

  parse(content: string, _filePath?: string, extraAllocators?: string[], extraDeallocators?: string[]): ParseResult {
    const safe = (xs?: string[]) => (xs || []).filter((s) => /^[A-Za-z_]\w*$/.test(s)).sort();
    const ea = safe(extraAllocators);
    const ed = safe(extraDeallocators);
    const cpp = CParserService.isCppPath(_filePath);
    // Cache key includes the extra names + language — different sets/language ⇒ different parse.
    const key = createHash('sha1').update(`${cpp ? 'cpp' : 'c'} ${content} ${ea.join(',')} ${ed.join(',')}`).digest('base64');
    const hit = this.cache.get(key);
    if (hit) {
      // LRU bump: re-insert so the most-recently-used stays last.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    // Set the per-parse sets just before the SYNCHRONOUS tree-sitter walk (no await
    // in between, so no cross-call race on a shared singleton).
    this.allocSet = ea.length ? new Set([...ALLOCATION_FUNCTIONS, ...ea]) : ALLOCATION_FUNCTIONS;
    this.freeSet = ed.length ? new Set([...DEALLOCATION_FUNCTIONS, ...ed]) : DEALLOCATION_FUNCTIONS;
    const result = this.parseWithTreeSitter(content, cpp);
    this.allocSet = ALLOCATION_FUNCTIONS;
    this.freeSet = DEALLOCATION_FUNCTIONS;
    this.cache.set(key, result);
    if (this.cache.size > CParserService.CACHE_MAX) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
    return result;
  }

  private parseWithTreeSitter(content: string, cpp = false): ParseResult {
    try {
      const parser = this.getParser(cpp);
      const tree = parser.parse(content);
      const root = tree.rootNode;
      const lines = content.split('\n');

      const funcNodes = findAllNodes(root, 'function_definition');
      const functions: FunctionInfo[] = [];

      for (const funcNode of funcNodes) {
        const info = buildFunctionInfo(funcNode, lines, this.allocSet, this.freeSet);
        if (info) {
          // Enrich with CFG analysis
          const body = findChild(funcNode, 'compound_statement');
          if (body) {
            info.controlFlow = buildControlFlowGraph(body, lines, info, this.allocSet, this.freeSet);
            info.exitPaths = analyzeExitPaths(body, lines, info);
            info.loops = detectLoops(body, lines, info, this.allocSet, this.freeSet);
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`tree-sitter parse failed: ${msg}`);
      return { functions: [], functionNames: [] };
    }
  }
}
