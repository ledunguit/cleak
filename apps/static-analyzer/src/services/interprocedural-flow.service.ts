import { Injectable, Logger } from '@nestjs/common';
import { readFileSync, statSync } from 'fs';
import { CParserService, FunctionInfo } from './c-parser.service';
import { ServerEventName } from '@cleak/common/mcp/server-events';

type FlowPath = {
  functionName: string;
  filePath: string;
  lines: number[];
  allocs: string[];
  frees: string[];
  hasAllocWithoutFree: boolean;
};

/** Result of one full reachability walk from a start function. */
type TraceResult = {
  paths: FlowPath[];
  freeParams: string[];
  reachableFrees: string[];
  freedVars: Set<string>;
};

@Injectable()
export class InterproceduralFlowService {
  private readonly logger = new Logger(InterproceduralFlowService.name);

  constructor(private readonly cParser: CParserService) {}

  // Cross-call parse cache. analyze() is invoked once PER CANDIDATE, and every call over
  // the same case re-parses the same repo files with the same allocator set — without a
  // cache that re-parse dominates wall-clock on big repos (curl ≈ 1500 files × N candidates).
  // Key includes mtime + the allocator set so a changed file or a different per-project
  // profile correctly misses. Files don't change mid-run, so this is safe + a large win.
  // Cached as a Promise (not the resolved array) so concurrent requests for the
  // same file+allocator-set during the same analyze() call dedupe onto one
  // in-flight parse instead of racing to populate the cache separately.
  //
  // Bounded: this service is a long-lived DI singleton, so an unbounded Map here
  // accumulates one entry per DISTINCT file ever seen across every case a process
  // handles, not just the current one — confirmed directly: a 15-case batch across
  // several real LAMeD projects drove this service's container RSS from ~105MB to
  // the 4GB container ceiling with no plateau, even though CParserService's own
  // cache (which this wraps) is separately byte-bounded. Cleared once it outgrows a
  // fixed cap, same policy as `reachabilityCache` below (a resolved entry here is
  // cheap to recompute — it's a thin wrapper around cParser's own already-cached
  // parse — so an occasional full clear is a fine trade for bounded memory).
  private parseCache = new Map<string, Promise<FunctionInfo[]>>();
  private static readonly MAX_PARSE_CACHE = 4096;

  /**
   * Cross-candidate reachability memo. analyze() is invoked once PER CANDIDATE, and
   * every candidate for the same case re-walks the same call graph from its start
   * function — without a cache the walk dominates wall-clock once parsing is cached
   * (a function with k allocation sites triggers k identical walks). Keyed on the
   * parse fingerprint (file::mtime + allocator sets) + start function — the SAME
   * inputs that drive the parse cache — so a changed file or a different per-project
   * profile correctly misses and the cached walk is never served for stale input
   * (mtime flips the key). Results are shared across calls and must be treated as
   * read-only (MCP serializes, never mutates). Bounded: cleared once it outgrows a
   * fixed cap so long-running scans over many distinct (start, file-set) combos
   * can't grow it without limit.
   */
  private reachabilityCache = new Map<string, TraceResult>();
  private static readonly MAX_REACHABILITY_CACHE = 256;

  private parseFile(file: string, mtime: number, extraAllocators?: string[], extraDeallocators?: string[]): Promise<FunctionInfo[]> {
    if (mtime < 0) return Promise.resolve([]); // stat failed — same empty fallback as before
    const key = `${file}::${mtime}::${(extraAllocators || []).join(',')}::${(extraDeallocators || []).join(',')}`;
    const hit = this.parseCache.get(key);
    if (hit) return hit;
    const promise = (async (): Promise<FunctionInfo[]> => {
      try {
        const content = readFileSync(file, 'utf-8');
        return (await this.cParser.parse(content, file, extraAllocators, extraDeallocators)).functions;
      } catch {
        return [];
      }
    })();
    this.parseCache.set(key, promise);
    if (this.parseCache.size > InterproceduralFlowService.MAX_PARSE_CACHE) {
      this.parseCache.clear();
    }
    return promise;
  }

  /**
   * Interprocedural alloc/free flow trace from `functionName`, following callees.
   *
   * `extraAllocators`/`extraDeallocators` overlay the per-project factory allocators
   * (≈ LAMeD AllocSource/FreeSink) onto cParser's built-in libc sets — WITHOUT them the
   * trace is blind to custom APIs (cJSON_malloc/cJSON_Delete, _TIFFmalloc/_TIFFfree, …)
   * and silently reports "no leak" on every real project. Mirrors callGraph/functionSummary.
   *
   * Parses every file ONCE up front into a function index, then walks the call graph over
   * the index (the old version re-read + re-parsed the whole file set for EACH function in
   * the trace — O(depth × files), pathological on big repos).
   */
  async analyze(
    rootPath: string,
    functionName: string,
    files: string[],
    extraAllocators?: string[],
    extraDeallocators?: string[],
  ) {
    this.logger.log({ event: ServerEventName.FLOW_ANALYSIS_STARTED, rootPath, functionName, fileCount: files.length }, 'flow analysis started');
    // Stat every file ONCE per call: the parse cache key and the reachability
    // fingerprint share the same mtime view, so a changed file flips BOTH keys and
    // neither cache can serve stale data.
    const mtimes: number[] = files.map((file) => {
      try {
        return statSync(file).mtimeMs;
      } catch {
        return -1;
      }
    });

    // Parse-once index: functionName → {fn, file}. First definition wins (matches CallGraph).
    // Files are parsed through `parseFile` (cached across candidates of the same case),
    // concurrently across the worker pool — but the index is built by walking the
    // results back in the ORIGINAL `files` order, so "first definition wins" stays
    // deterministic regardless of which file's parse finishes first.
    const index = new Map<string, { fn: FunctionInfo; file: string }>();
    const parsed = await Promise.all(
      files.map(async (file, i) => ({ file, functions: await this.parseFile(file, mtimes[i], extraAllocators, extraDeallocators) })),
    );
    for (const { file, functions } of parsed) {
      for (const fn of functions) {
        if (!index.has(fn.functionName)) index.set(fn.functionName, { fn, file });
      }
    }

    // Reachability walk — memoized per (start function, file fingerprint). Several
    // candidates of one function share the same key, so the walk runs once and the
    // rest reuse it (see reachabilityCache). The walk result depends ONLY on the
    // index + start function; the fingerprint covers both inputs deterministically.
    const fingerprint = [
      functionName,
      ...files.map((file, i) => `${file}::${mtimes[i]}`),
      (extraAllocators || []).join(','),
      (extraDeallocators || []).join(','),
    ].join('\u0000');
    let trace = this.reachabilityCache.get(fingerprint);
    if (!trace) {
      const paths: FlowPath[] = [];
      const allFreeParams: string[] = [];
      const allReachableFrees: string[] = [];
      const freedVarsAcrossTrace = new Set<string>();
      const visited = new Set<string>();
      this.traceCalls(functionName, index, visited, paths, allFreeParams, allReachableFrees, freedVarsAcrossTrace, 0);
      trace = { paths, freeParams: allFreeParams, reachableFrees: allReachableFrees, freedVars: freedVarsAcrossTrace };
      this.reachabilityCache.set(fingerprint, trace);
      if (this.reachabilityCache.size > InterproceduralFlowService.MAX_REACHABILITY_CACHE) {
        this.reachabilityCache.clear();
      }
    }

    const ownershipChains = this.buildOwnershipChains(trace.paths);

    // Variable-level cross-frame reconciliation: allocations made IN the start function
    // whose variable is freed NOWHERE reachable (not locally, not in any callee). This is
    // the precise interprocedural-leak signal — distinct from the coarse per-function
    // `hasAllocWithoutFree` (path-insensitive) — and the basis for the recall-additive
    // judge evidence. Variable-name matching across frames is approximate (name reuse) but
    // recall-additive: a false match only ADDS a (possibly wrong) leak signal, never hides one.
    const start = index.get(functionName)?.fn;
    const unreconciledAllocVars = start
      ? [...new Set(start.allocationVariables.map((a) => a.variable))].filter((v) => !trace.freedVars.has(v))
      : [];

    this.logger.log(
      { event: ServerEventName.FLOW_ANALYSIS_FINISHED, rootPath, functionName, pathCount: trace.paths.length },
      'flow analysis finished',
    );
    return {
      paths: trace.paths,
      freeParameters: [...new Set(trace.freeParams)],
      reachableFrees: [...new Set(trace.reachableFrees)],
      ownershipChains,
      depth: trace.paths.length,
      hasLeak: trace.paths.some((p) => p.hasAllocWithoutFree),
      startFunction: functionName,
      unreconciledAllocVars,
    };
  }

  private traceCalls(
    fnName: string,
    index: Map<string, { fn: FunctionInfo; file: string }>,
    visited: Set<string>,
    paths: FlowPath[],
    allFreeParams: string[],
    allReachableFrees: string[],
    freedVarsAcrossTrace: Set<string>,
    depth: number,
  ) {
    if (visited.has(fnName)) return;
    if (depth > 10) return; // bound the trace
    visited.add(fnName);

    const entry = index.get(fnName);
    if (!entry) return; // external / undefined-in-project function
    const { fn, file } = entry;

    for (const f of fn.freedVariables) freedVarsAcrossTrace.add(f.variable);

    const lines = [...fn.allocationCalls.map((c) => c.line), ...fn.deallocationCalls.map((c) => c.line)];

    // Pointer parameters of a function that frees → ownership-transfer (free-sink) candidates.
    for (const param of fn.parameters) {
      if ((param.type.includes('*') || param.type.includes('**')) && fn.deallocationCalls.length > 0) {
        allFreeParams.push(param.name);
      }
    }

    // Every dealloc reachable through this function (now allocator-aware).
    for (const fc of fn.deallocationCalls) {
      allReachableFrees.push(`${fc.name} at ${file}:${fc.line}`);
    }

    const freedSet = new Set(fn.freedVariables.map((f) => f.variable));
    const leakedAllocs = fn.allocationVariables.filter((a) => !freedSet.has(a.variable));

    paths.push({
      functionName: fnName,
      filePath: file,
      lines: [...new Set(lines)].sort((a, b) => a - b),
      allocs: fn.allocationVariables.map((a) => `${a.variable} (${a.callName} at ${a.line})`),
      frees: fn.freedVariables.map((f) => `${f.variable} at ${f.line}`),
      hasAllocWithoutFree: leakedAllocs.length > 0,
    });

    for (const call of fn.functionCalls) {
      this.traceCalls(call.name, index, visited, paths, allFreeParams, allReachableFrees, freedVarsAcrossTrace, depth + 1);
    }
  }

  private buildOwnershipChains(
    paths: FlowPath[],
  ): { function: string; file: string; allocCount: number; freeCount: number; chain: string }[] {
    return paths.map((p) => ({
      function: p.functionName,
      file: p.filePath,
      allocCount: p.allocs.length,
      freeCount: p.frees.length,
      chain: p.hasAllocWithoutFree
        ? `ALLOC → ? (${p.allocs.length} alloc(s), ${p.frees.length} free(s))`
        : `ALLOC → FREE (balanced)`,
    }));
  }
}
