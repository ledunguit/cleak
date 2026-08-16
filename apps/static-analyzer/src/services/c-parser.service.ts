import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
   * shared across callers.
   *
   * Bounded by BYTES, not entry count: a sweep over many large real-world
   * repos (e.g. LAMeD, one case = up to 143 files) fills a small number of
   * huge entries far faster than a small number of tiny ones, so an
   * entry-count cap under-protects memory on exactly the workload that most
   * needs protecting (confirmed via a controlled single-case load test: one
   * large libxml2 checkout alone drove this service's RSS from ~112MB to
   * ~1.13GB). Same LRU eviction order as before (delete+re-insert on hit),
   * now evicting oldest entries until under the byte budget rather than the
   * entry-count budget.
   *
   * Lives on the main thread (single source of truth) regardless of whether
   * parsing itself runs in-process or on a worker — workers stay stateless.
   */
  private readonly cache = new Map<string, ParseResult>();
  private readonly cacheBytes = new Map<string, number>();
  private cacheTotalBytes = 0;
  private static readonly CACHE_MAX_BYTES = Math.max(16, Number(process.env.STATIC_PARSER_CACHE_MAX_MB) || 256) * 1024 * 1024;

  /**
   * Disk-backed second tier, content-hash-keyed like the in-memory cache
   * above. Purpose: a baseline sweep re-scans the SAME unchanged project
   * checkout many times over (up to 9 capability configs x 3 repeats each,
   * see evaluation/baselines.ts), and the in-memory cache alone is lost on
   * every process restart between those runs. Persisting to disk means the
   * (deterministic) tree-sitter parse only has to happen once per distinct
   * file content across an entire sweep, not once per (config, repeat, file)
   * combination. Reuses the RUNS_DIR convention already established by
   * ScanBuildAdapterService. Skipped entirely in tests unless a cache dir is
   * explicitly set, mirroring the worker-pool's own NODE_ENV==='test' guard.
   */
  private readonly diskCacheDir: string | null =
    process.env.NODE_ENV === 'test' && !process.env.STATIC_PARSER_DISK_CACHE_DIR
      ? null
      : resolve(process.env.STATIC_PARSER_DISK_CACHE_DIR || join(process.env.RUNS_DIR || './runs', 'ast-cache'));
  private static readonly DISK_CACHE_MAX_ENTRIES = Math.max(1, Number(process.env.STATIC_PARSER_DISK_CACHE_MAX_ENTRIES) || 5000);

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
    // Each worker keeps a long-lived tree-sitter parser singleton across every
    // task it ever runs (see parse.worker.ts) — memory growth is CUMULATIVE
    // over the worker's lifetime, not per-task, and nothing here previously
    // bounded it. That's the actual reason 5 workers OOM-killed the container
    // on a real load test even though 5 threads alone shouldn't: the container
    // died from unbounded accumulation, not raw thread count. `resourceLimits`
    // gives V8 a real ceiling PER WORKER — Piscina auto-respawns a worker that
    // hits it (a controlled, cheap restart) instead of the whole container
    // dying uncontrolled. `maxOldGenerationSizeMb` default here is a
    // conservative starting point, NOT a profiled number — raise/lower it
    // after measuring real per-worker RSS under load (`docker stats` during
    // the MemHint 19-case load test already used for STATIC_PARSER_WORKERS).
    const maxOldGenerationMb = Math.max(64, Number(process.env.STATIC_PARSER_MAX_OLD_GEN_MB) || 512);
    this.pool = new Piscina({
      filename: workerPath,
      minThreads: workers,
      maxThreads: workers,
      resourceLimits: { maxOldGenerationSizeMb: maxOldGenerationMb },
      // A worker sitting idle this long is recycled too — bounds worst-case
      // heap fragmentation even for a worker that never quite hits the hard
      // ceiling above.
      idleTimeout: 5 * 60_000,
    });
    this.logger.log(`parse worker pool started: ${workers} thread(s), ${maxOldGenerationMb}MB/worker heap cap (${workerPath})`);
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
    // base64url (not base64): the key doubles as a disk-cache filename below,
    // and plain base64's `/` would otherwise be interpreted as a path separator.
    const key = createHash('sha1').update(`${cpp ? 'cpp' : 'c'} ${content} ${ea.join(',')} ${ed.join(',')}`).digest('base64url');
    const memHit = this.cache.get(key);
    if (memHit) {
      // LRU bump: re-insert so the most-recently-used stays last.
      this.cache.delete(key);
      this.cache.set(key, memHit);
      return memHit;
    }
    const diskHit = this.readDiskCache(key);
    if (diskHit) {
      this.insertMemCache(key, diskHit);
      return diskHit;
    }
    const result = await this.runParse(content, cpp, ea, ed);
    this.insertMemCache(key, result);
    this.writeDiskCache(key, result);
    return result;
  }

  private insertMemCache(key: string, result: ParseResult): void {
    const size = Buffer.byteLength(JSON.stringify(result));
    this.cache.set(key, result);
    this.cacheBytes.set(key, size);
    this.cacheTotalBytes += size;
    while (this.cacheTotalBytes > CParserService.CACHE_MAX_BYTES && this.cache.size > 1) {
      const oldestKey = this.cache.keys().next().value as string;
      this.cacheTotalBytes -= this.cacheBytes.get(oldestKey) ?? 0;
      this.cache.delete(oldestKey);
      this.cacheBytes.delete(oldestKey);
    }
  }

  private diskCachePath(key: string): string | null {
    return this.diskCacheDir ? join(this.diskCacheDir, `${key}.json`) : null;
  }

  private readDiskCache(key: string): ParseResult | null {
    const path = this.diskCachePath(key);
    if (!path || !existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as ParseResult;
    } catch (err) {
      this.logger.warn(`ast disk cache read failed for ${key}, recomputing: ${err}`);
      return null;
    }
  }

  private writeDiskCache(key: string, result: ParseResult): void {
    const path = this.diskCachePath(key);
    if (!path) return;
    try {
      if (!existsSync(this.diskCacheDir!)) mkdirSync(this.diskCacheDir!, { recursive: true });
      writeFileSync(path, JSON.stringify(result));
      this.sweepDiskCache();
    } catch (err) {
      // Best-effort: a disk-cache write failure must never fail the parse itself.
      this.logger.warn(`ast disk cache write failed for ${key}: ${err}`);
    }
  }

  /** Keep only the most recently modified `STATIC_PARSER_DISK_CACHE_MAX_ENTRIES`
   * (default 5000) entries under the disk cache dir, deleting older ones.
   * Mirrors dynamic-analyzer's HarnessBuildService.sweepOldRunDirs() pattern —
   * best-effort, never blocks or fails the caller's parse on a cleanup error. */
  private sweepDiskCache(): void {
    if (!this.diskCacheDir) return;
    try {
      const entries = readdirSync(this.diskCacheDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => {
          const full = join(this.diskCacheDir!, e.name);
          let mtimeMs = 0;
          try {
            mtimeMs = statSync(full).mtimeMs;
          } catch {
            /* entry vanished mid-sweep — treat as oldest */
          }
          return { full, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
      for (const stale of entries.slice(CParserService.DISK_CACHE_MAX_ENTRIES)) {
        try {
          unlinkSync(stale.full);
        } catch (err) {
          this.logger.warn(`failed to remove stale ast cache entry ${stale.full}: ${err}`);
        }
      }
    } catch (err) {
      this.logger.warn(`ast disk cache retention sweep failed: ${err}`);
    }
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
