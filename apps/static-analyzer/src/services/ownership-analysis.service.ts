import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import { CParserService } from './c-parser.service';

@Injectable()
export class OwnershipAnalysisService {
  constructor(private readonly cParser: CParserService) {}

  summarize(files: string[], rootPath: string) {
    const ownerships: {
      functionName: string;
      filePath: string;
      ownershipType: string;
      allocatedObjects: string[];
      leakPaths: number;
      leakRisk: string;
    }[] = [];

    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf-8');
        const result = this.cParser.parse(content, file);

        for (const fn of result.functions) {
          const ownershipType = this.inferOwnershipType(fn);
          const allocatedObjects = fn.allocationVariables.map((a) => a.variable);
          const leakyPaths = fn.exitPaths.filter((p) => p.leakRisk !== 'none');

          if (allocatedObjects.length > 0 || ownershipType !== 'none') {
            ownerships.push({
              functionName: fn.functionName,
              filePath: file,
              ownershipType,
              allocatedObjects,
              leakPaths: leakyPaths.length,
              leakRisk: this.computeLeakRisk(fn),
            });
          }
        }
      } catch {
        // skip
      }
    }

    return { ownerships };
  }

  conventions(content: string, filePath: string) {
    const rules: { pattern: string; description: string; conventionType: string }[] = [];
    const result = this.cParser.parse(content, filePath);

    for (const fn of result.functions) {
      const hasAlloc = fn.allocationCalls.length > 0;
      const hasFree = fn.deallocationCalls.length > 0;
      const freedNames = new Set(fn.freedVariables.map((f) => f.variable));

      // malloc without free
      if (hasAlloc && !hasFree) {
        rules.push({
          pattern: `${fn.functionName} allocates but never frees`,
          description: 'Function allocates memory via malloc/calloc/strdup but has no matching free call anywhere in the function body.',
          conventionType: 'leak_risk',
        });
      }

      // Allocation variable not freed
      for (const alloc of fn.allocationVariables) {
        if (!freedNames.has(alloc.variable)) {
          rules.push({
            pattern: `${alloc.variable} allocated via ${alloc.callName} at line ${alloc.line} never freed`,
            description: `'${alloc.variable}' = ${alloc.callName}() without matching free(). Variable may escape via return or store.`,
            conventionType: 'missing_free',
          });
        }
      }

      // Loop allocation without loop free
      for (const loop of fn.loops) {
        if (loop.bodyHasAllocation && !loop.bodyHasFree) {
          const loopAllocVars = fn.allocationVariables.filter(
            (a) => a.line >= loop.line && a.line <= loop.line + 20,
          );
          rules.push({
            pattern: `Loop at line ${loop.line} allocates but never frees inside loop body`,
            description: `${loop.kind} loop at line ${loop.line} contains ${loopAllocVars.length} allocation(s) (${loopAllocVars.map(a => a.variable).join(', ')}) with no matching free() inside the loop.`,
            conventionType: 'loop_leak',
          });
        }
      }

      // Early return without free
      for (const ret of fn.returnStatements) {
        const allocsBefore = fn.allocationVariables.filter(
          (a) => a.line < ret.line,
        );
        const freesBefore = fn.freedVariables.filter(
          (f) => f.line < ret.line,
        );

        const notFreed = allocsBefore.filter(
          (a) => !freesBefore.some((f) => f.variable === a.variable),
        );

        if (notFreed.length > 0) {
          rules.push({
            pattern: `${fn.functionName} returns at line ${ret.line} without freeing ${notFreed.map(a => a.variable).join(', ')}`,
            description: `Return at line ${ret.line} is reached before free() is called for ${notFreed.length} allocation(s).`,
            conventionType: 'early_return_leak',
          });
        }
      }
    }

    return { rules };
  }

  private inferOwnershipType(fn: {
    functionName: string;
    allocationVariables: { variable: string; line: number; callName: string }[];
    freedVariables: { variable: string; line: number }[];
    parameters: { name: string; type: string }[];
    returnStatements: { line: number; text: string }[];
  }): string {
    const freedNames = new Set(fn.freedVariables.map((f) => f.variable));
    const allocNotFreed = fn.allocationVariables.filter(
      (a) => !freedNames.has(a.variable),
    ).length;

    // Returns allocated memory → "returns_ownership"
    if (allocNotFreed > 0) return 'returns_ownership';

    // Takes pointer and frees → "consumes_ownership"
    const hasPointerParam = fn.parameters.some((p) => p.type.includes('*'));
    if (hasPointerParam && fn.freedVariables.length > 0) return 'consumes_ownership';

    // Allocates and frees locally → "local_ownership"
    const allocCount = fn.allocationVariables.length;
    if (allocCount > 0 && allocNotFreed === 0) return 'local_ownership';

    return 'none';
  }

  private computeLeakRisk(fn: {
    allocationVariables: { variable: string; line: number; callName: string }[];
    freedVariables: { variable: string; line: number }[];
    deallocationCalls: { name: string; line: number }[];
    exitPaths: { leakRisk: string; unreconciledAllocations: string[] }[];
  }): string {
    if (fn.exitPaths.some((p) => p.leakRisk === 'high')) return 'high';
    if (fn.exitPaths.some((p) => p.leakRisk === 'medium')) return 'medium';
    if (fn.allocationVariables.length > 0 && fn.deallocationCalls.length === 0) return 'high';
    return 'low';
  }
}
