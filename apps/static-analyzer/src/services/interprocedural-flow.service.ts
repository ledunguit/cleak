import { Injectable } from '@nestjs/common';
import { readFileSync, statSync } from 'fs';
import { CParserService, FunctionInfo } from './c-parser.service';

type FlowPath = {
  functionName: string;
  filePath: string;
  lines: number[];
  allocs: string[];
  frees: string[];
  hasAllocWithoutFree: boolean;
};

@Injectable()
export class InterproceduralFlowService {
  constructor(private readonly cParser: CParserService) {}

  // Cross-call parse cache. analyze() is invoked once PER CANDIDATE, and every call over
  // the same case re-parses the same repo files with the same allocator set — without a
  // cache that re-parse dominates wall-clock on big repos (curl ≈ 1500 files × N candidates).
  // Key includes mtime + the allocator set so a changed file or a different per-project
  // profile correctly misses. Files don't change mid-run, so this is safe + a large win.
  private parseCache = new Map<string, FunctionInfo[]>();

  private parseFile(file: string, extraAllocators?: string[], extraDeallocators?: string[]): FunctionInfo[] {
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      return [];
    }
    const key = `${file}::${mtime}::${(extraAllocators || []).join(',')}::${(extraDeallocators || []).join(',')}`;
    const hit = this.parseCache.get(key);
    if (hit) return hit;
    let functions: FunctionInfo[] = [];
    try {
      const content = readFileSync(file, 'utf-8');
      functions = this.cParser.parse(content, file, extraAllocators, extraDeallocators).functions;
    } catch {
      functions = [];
    }
    this.parseCache.set(key, functions);
    return functions;
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
  analyze(
    rootPath: string,
    functionName: string,
    files: string[],
    extraAllocators?: string[],
    extraDeallocators?: string[],
  ) {
    // Parse-once index: functionName → {fn, file}. First definition wins (matches CallGraph).
    // Files are parsed through `parseFile` (cached across candidates of the same case).
    const index = new Map<string, { fn: FunctionInfo; file: string }>();
    for (const file of files) {
      for (const fn of this.parseFile(file, extraAllocators, extraDeallocators)) {
        if (!index.has(fn.functionName)) index.set(fn.functionName, { fn, file });
      }
    }

    const paths: FlowPath[] = [];
    const visited = new Set<string>();
    const allFreeParams: string[] = [];
    const allReachableFrees: string[] = [];
    const freedVarsAcrossTrace = new Set<string>();

    this.traceCalls(functionName, index, visited, paths, allFreeParams, allReachableFrees, freedVarsAcrossTrace, 0);

    const ownershipChains = this.buildOwnershipChains(paths);

    // Variable-level cross-frame reconciliation: allocations made IN the start function
    // whose variable is freed NOWHERE reachable (not locally, not in any callee). This is
    // the precise interprocedural-leak signal — distinct from the coarse per-function
    // `hasAllocWithoutFree` (path-insensitive) — and the basis for the recall-additive
    // judge evidence. Variable-name matching across frames is approximate (name reuse) but
    // recall-additive: a false match only ADDS a (possibly wrong) leak signal, never hides one.
    const start = index.get(functionName)?.fn;
    const unreconciledAllocVars = start
      ? [...new Set(start.allocationVariables.map((a) => a.variable))].filter((v) => !freedVarsAcrossTrace.has(v))
      : [];

    return {
      paths,
      freeParameters: [...new Set(allFreeParams)],
      reachableFrees: [...new Set(allReachableFrees)],
      ownershipChains,
      depth: paths.length,
      hasLeak: paths.some((p) => p.hasAllocWithoutFree),
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
