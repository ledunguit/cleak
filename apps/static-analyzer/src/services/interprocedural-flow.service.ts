import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import { CParserService } from './c-parser.service';

@Injectable()
export class InterproceduralFlowService {
  constructor(private readonly cParser: CParserService) {}

  analyze(rootPath: string, functionName: string, files: string[]) {
    const paths: { functionName: string; filePath: string; lines: number[]; allocs: string[]; frees: string[]; hasAllocWithoutFree: boolean }[] = [];
    const visited = new Set<string>();
    const allFreeParams: string[] = [];
    const allReachableFrees: string[] = [];

    this.traceCalls(functionName, files, visited, paths, allFreeParams, allReachableFrees);

    // Build ownership chains
    const ownershipChains = this.buildOwnershipChains(paths);

    return {
      paths,
      freeParameters: [...new Set(allFreeParams)],
      reachableFrees: [...new Set(allReachableFrees)],
      ownershipChains,
      depth: paths.length,
      hasLeak: paths.some((p) => p.hasAllocWithoutFree),
    };
  }

  private traceCalls(
    fnName: string,
    files: string[],
    visited: Set<string>,
    paths: { functionName: string; filePath: string; lines: number[]; allocs: string[]; frees: string[]; hasAllocWithoutFree: boolean }[],
    allFreeParams: string[],
    allReachableFrees: string[],
    depth: number = 0,
  ) {
    if (visited.has(fnName)) return;
    if (depth > 10) return; // Limit depth
    visited.add(fnName);

    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf-8');
        const result = this.cParser.parse(content, file);

        for (const fn of result.functions) {
          if (fn.functionName === fnName) {
            const lines = [
              ...fn.allocationCalls.map((c) => c.line),
              ...fn.deallocationCalls.map((c) => c.line),
            ];

            // Check if function takes pointer parameters (ownership transfer candidates)
            for (const param of fn.parameters) {
              if (param.type.includes('*') || param.type.includes('**')) {
                if (fn.deallocationCalls.length > 0) {
                  allFreeParams.push(param.name);
                }
              }
            }

            // Collect all frees reachable through this function
            for (const fc of fn.deallocationCalls) {
              allReachableFrees.push(`${fc.name} at ${file}:${fc.line}`);
            }

            // Determine if this function has allocations without local frees
            const freedSet = new Set(fn.freedVariables.map((f) => f.variable));
            const leakedAllocs = fn.allocationVariables.filter(
              (a) => !freedSet.has(a.variable),
            );

            paths.push({
              functionName: fnName,
              filePath: file,
              lines: [...new Set(lines)].sort((a, b) => a - b),
              allocs: fn.allocationVariables.map((a) => `${a.variable} (${a.callName} at ${a.line})`),
              frees: fn.freedVariables.map((f) => `${f.variable} at ${f.line}`),
              hasAllocWithoutFree: leakedAllocs.length > 0,
            });

            // Trace callees
            for (const call of fn.functionCalls) {
              this.traceCalls(call.name, files, visited, paths, allFreeParams, allReachableFrees, depth + 1);
            }
          }
        }
      } catch {
        // skip
      }
    }
  }

  private buildOwnershipChains(
    paths: { functionName: string; filePath: string; lines: number[]; allocs: string[]; frees: string[]; hasAllocWithoutFree: boolean }[],
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
