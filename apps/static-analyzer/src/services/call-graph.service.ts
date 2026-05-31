import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import { CParserService, ControlFlowGraph } from './c-parser.service';

@Injectable()
export class CallGraphService {
  constructor(private readonly cParser: CParserService) {}

  extract(rootPath: string, files: string[]) {
    const allFunctions: Map<string, string> = new Map();
    const callEdges: { caller: string; callee: string; filePath: string; lineNumber: number; callee_file?: string }[] = [];
    const recursionCycles: string[][] = [];

    // First pass: collect all internal function names with their files
    const functionToFile = new Map<string, string>();

    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf-8');
        const result = this.cParser.parse(content, file);
        for (const fn of result.functions) {
          allFunctions.set(fn.functionName, file);
          functionToFile.set(fn.functionName, file);
        }
      } catch {
        // skip unreadable
      }
    }

    // Second pass: build edges with CFG-aware analysis
    const calleeToCallers = new Map<string, string[]>();

    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf-8');
        const result = this.cParser.parse(content, file);

        for (const fn of result.functions) {
          for (const call of fn.functionCalls) {
            // Only track calls to functions defined in this project (internal calls)
            const calleeFile = functionToFile.get(call.name);
            callEdges.push({
              caller: fn.functionName,
              callee: call.name,
              filePath: file,
              lineNumber: call.line,
              callee_file: calleeFile || undefined,
            });

            // Track for cycle detection
            if (calleeFile) {
              if (!calleeToCallers.has(call.name)) {
                calleeToCallers.set(call.name, []);
              }
              calleeToCallers.get(call.name)!.push(fn.functionName);
            }
          }
        }
      } catch {
        // skip
      }
    }

    // Third pass: detect recursion cycles (direct + indirect)
    for (const [fnName] of allFunctions) {
      const directRecursion = callEdges.filter(
        (e) => e.caller === fnName && e.callee === fnName,
      );
      if (directRecursion.length > 0) {
        recursionCycles.push([fnName]); // direct recursion
      }
    }

    // Indirect recursion: simple DFS limited to depth 5
    for (const [fnName] of allFunctions) {
      const visited = new Set<string>();
      const path: string[] = [fnName];
      visited.add(fnName);
      this.detectIndirectRecursion(fnName, fnName, callEdges, visited, path, recursionCycles, 5);
    }

    // Deduplicate cycles
    const uniqueCycles = new Set<string>();
    const dedupedCycles = recursionCycles.filter((cycle) => {
      const key = [...cycle].sort().join('->');
      if (uniqueCycles.has(key)) return false;
      uniqueCycles.add(key);
      return true;
    });

    const nodes = Array.from(allFunctions.entries()).map(([name, file]) => ({
      functionName: name,
      filePath: file,
    }));

    // Allocation-to-free reachability analysis
    const allocFreeChains = this.analyzeAllocFreeChains(files, callEdges);

    return {
      edges: callEdges,
      nodes,
      recursionCycles: dedupedCycles,
      allocFreeChains,
      stats: {
        totalFunctions: nodes.length,
        totalEdges: callEdges.length,
        internalEdges: callEdges.filter((e) => e.callee_file).length,
        externalCalls: callEdges.filter((e) => !e.callee_file).length,
        recursionCycles: dedupedCycles.length,
      },
    };
  }

  private detectIndirectRecursion(
    startFn: string,
    currentFn: string,
    edges: { caller: string; callee: string }[],
    visited: Set<string>,
    path: string[],
    cycles: string[][],
    maxDepth: number,
  ) {
    if (path.length >= maxDepth) return;

    const outgoing = edges.filter((e) => e.caller === currentFn && e.callee !== currentFn);

    for (const edge of outgoing) {
      if (edge.callee === startFn && path.length > 1) {
        cycles.push([...path, startFn]);
        continue;
      }

      if (!visited.has(edge.callee)) {
        visited.add(edge.callee);
        path.push(edge.callee);
        this.detectIndirectRecursion(startFn, edge.callee, edges, visited, path, cycles, maxDepth);
        path.pop();
        visited.delete(edge.callee);
      }
    }
  }

  private analyzeAllocFreeChains(
    files: string[],
    edges: { caller: string; callee: string }[],
  ): { allocFunction: string; freeFunction: string; callers: string[] }[] {
    const chains: { allocFunction: string; freeFunction: string; callers: string[] }[] = [];
    const allocFuncs = ['malloc', 'calloc', 'realloc', 'strdup'];
    const freeFuncs = ['free', 'xfree'];

    for (const allocFn of allocFuncs) {
      for (const freeFn of freeFuncs) {
        // Find functions that call allocFn AND freeFn (potential balanced alloc/free)
        const allocCallers = new Set(
          edges.filter((e) => e.callee === allocFn).map((e) => e.caller),
        );
        const freeCallers = new Set(
          edges.filter((e) => e.callee === freeFn).map((e) => e.caller),
        );
        const commonCallers = [...allocCallers].filter((c) => freeCallers.has(c));

        if (commonCallers.length > 0) {
          chains.push({ allocFunction: allocFn, freeFunction: freeFn, callers: commonCallers });
        }
      }
    }

    return chains;
  }
}
