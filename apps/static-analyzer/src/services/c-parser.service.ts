import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';
import Piscina from 'piscina';
import type { TreeSitterParser } from '../types/tree-sitter';
import { ALLOCATION_FUNCTIONS, DEALLOCATION_FUNCTIONS } from '@cleak/common/constants/allocators';
import { createParser, runParse } from './c-parser/parse-core';
import type { ParseResult } from './c-parser/c-parser.types';
import type { ParseTask } from '../workers/parse.worker';

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
export class CParserService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CParserService.name);

  /** Lazily-built, reused tree-sitter parsers (C and C++) for the IN-PROCESS
   * fallback path only (no worker pool — dev without a built worker.js, or
   * tests). Instantiated on first use. */
  private parser: TreeSitterParser | null = null;
  private cppParser: TreeSitterParser | null = null;
  /**
   * Parse-result cache keyed by content hash. The same file is parsed by several
   * tools (candidate-scan → ast-scan → function-summary); parsing is a pure
   * function of content, so we memoize it. Treat results as READ-ONLY — they are
   * shared across callers. Bounded LRU so a huge repo can't grow it without limit.
   * Lives on the main thread (single source of truth) regardless of whether
   * parsing itself runs in-process or on a worker — workers stay stateless.
   */
  private readonly cache = new Map<string, ParseResult>();
  private static readonly CACHE_MAX = 512;

  /**
   * Worker-thread pool that runs the CPU-bound tree-sitter parse off the main
   * event loop — without this, `candidateScan`/`astScan`/`functionSummary`/etc.
   * all serialize on ONE thread, and under concurrent MCP load (multiple eval
   * cases × discoveryConcurrency workers each) requests queue behind each
   * other and blow past the client's 60s timeout (reproduced directly: a
   * 19-case MemHint run timed out on 9/19 of the largest repos at default
   * concurrency). `null` when no built `parse.worker.js` exists (dev without a
   * webpack build, or tests) — `parse()` then falls back to in-process parsing,
   * functionally identical but without the throughput win.
   */
  private pool: Piscina | null = null;

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.STATIC_PARSER_WORKERS === '0') return;
    // Resolve relative to the actual entry script on disk (`node dist/main.js`
    // in Docker, or the nest-cli watch build in dev) rather than `__dirname`,
    // since webpack bundles every module into one `main.js` and does not
    // reliably preserve each module's original directory at runtime.
    const entryDir = process.argv[1] ? dirname(resolve(process.argv[1])) : __dirname;
    const workerPath = join(entryDir, 'workers', 'parse.worker.js');
    if (!existsSync(workerPath)) {
      this.logger.warn(`parse worker not found at ${workerPath} — falling back to in-process parsing (dev build without webpack worker entry?)`);
      return;
    }
    const workers = Math.max(1, Number(process.env.STATIC_PARSER_WORKERS) || Math.max(1, os.cpus().length - 1));
    this.pool = new Piscina({ filename: workerPath, minThreads: workers, maxThreads: workers });
    this.logger.log(`parse worker pool started: ${workers} thread(s) (${workerPath})`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) await this.pool.destroy();
  }

  /** True for C++ source/header extensions — they must be parsed by tree-sitter-cpp, not
   * tree-sitter-c (which misparses `new`/`delete`/templates/`::`/range-for). */
  static isCppPath(filePath?: string): boolean {
    return /\.(cc|cpp|cxx|c\+\+|hpp|hxx|hh|ipp|tcc|inl)$/i.test(filePath || '');
  }

  private getParser(cpp: boolean): TreeSitterParser {
    if (cpp) return (this.cppParser ??= createParser(true));
    return (this.parser ??= createParser(false));
  }

  async parse(content: string, _filePath?: string, extraAllocators?: string[], extraDeallocators?: string[]): Promise<ParseResult> {
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
    const result = await this.runParse(content, cpp, ea, ed);
    this.cache.set(key, result);
    if (this.cache.size > CParserService.CACHE_MAX) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
    return result;
  }

  private async runParse(content: string, cpp: boolean, extraAllocators: string[], extraDeallocators: string[]): Promise<ParseResult> {
    if (this.pool) {
      const task: ParseTask = { content, cpp, extraAllocators, extraDeallocators };
      try {
        return await this.pool.run(task);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`tree-sitter parse failed (worker): ${msg}`, err instanceof Error ? err.stack : undefined);
        return { functions: [], functionNames: [] };
      }
    }
    const allocSet = extraAllocators.length ? new Set([...ALLOCATION_FUNCTIONS, ...extraAllocators]) : ALLOCATION_FUNCTIONS;
    const freeSet = extraDeallocators.length ? new Set([...DEALLOCATION_FUNCTIONS, ...extraDeallocators]) : DEALLOCATION_FUNCTIONS;
    try {
      return runParse(this.getParser(cpp), content, allocSet, freeSet);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`tree-sitter parse failed: ${msg}`, err instanceof Error ? err.stack : undefined);
      return { functions: [], functionNames: [] };
    }
  }
}
