import { Injectable } from '@nestjs/common';
import { FeasibleLeakPath } from '@cleak/common';
import { CParserService, FunctionInfo } from './c-parser.service';

@Injectable()
export class PathConstraintsService {
  constructor(private readonly cParser: CParserService) {}

  analyze(filePath: string, content: string, lineNumber: number, extraAllocators?: string[], extraDeallocators?: string[]) {
    const result = this.cParser.parse(content, filePath, extraAllocators, extraDeallocators);

    const containingFunction = result.functions.find((fn) =>
      fn.lineNumber <= lineNumber &&
      this.functionEndLine(fn, result.functions) >= lineNumber,
    );

    if (!containingFunction) {
      return { constraints: [], feasiblePaths: [], exitPaths: [] };
    }

    // Extract all path constraints from conditions
    const constraints = containingFunction.conditions.map(
      (c) => `if (${c.text}) at line ${c.line}`,
    );

    // Use CFG exit paths for richer analysis
    const feasiblePaths = containingFunction.exitPaths
      .filter((p) => p.reachableFromEntry)
      .map((p) => ({
        kind: p.kind,
        line: p.exitLine,
        leakRisk: p.leakRisk,
        conditions: p.pathConditions,
        allocatedNotFreed: p.unreconciledAllocations,
      }));

    // Also compute path through target line
    const pathsToTarget = this.computePathsToLine(containingFunction, lineNumber);

    // Feasible leak paths: reachable exit paths that leave an allocation un-freed.
    // This existing reachability + condition logic IS the pre-LLM feasibility
    // filter the literature (MemHint) calls for — we only emit reachable paths.
    const feasibleLeakPaths = this.buildFeasibleLeakPaths(containingFunction);

    return {
      constraints,
      feasiblePaths,
      feasibleLeakPaths,
      exitPaths: containingFunction.exitPaths.map((p) => ({
        kind: p.kind,
        exitLine: p.exitLine,
        hasFreeOnPath: p.hasFreeOnPath,
        freeLines: p.freeLinesOnPath,
        leakRisk: p.leakRisk,
        unreconciledAllocations: p.unreconciledAllocations,
      })),
      pathsToTarget,
      containsEarlyReturn: containingFunction.returnStatements.length > 1,
      earlyReturnCount: containingFunction.returnStatements.length,
      totalExitPaths: containingFunction.exitPaths.length,
      leakyExitPaths: containingFunction.exitPaths.filter((p) => p.leakRisk !== 'none').length,
    };
  }

  private buildFeasibleLeakPaths(fn: FunctionInfo): FeasibleLeakPath[] {
    const allocByVar = new Map(
      fn.allocationVariables.map((a) => [a.variable, a]),
    );

    return fn.exitPaths
      .filter(
        (p) =>
          p.reachableFromEntry &&
          p.leakRisk !== 'none' &&
          p.unreconciledAllocations.length > 0,
      )
      .map((p) => ({
        kind: p.kind,
        exitLine: p.exitLine,
        reachable: p.reachableFromEntry,
        conditions: p.pathConditions,
        unreconciledAllocations: p.unreconciledAllocations,
        leakRisk: p.leakRisk,
        narrative: this.describeLeakPath(p, allocByVar),
        feasibilityChecked: 'heuristic' as const,
      }));
  }

  private describeLeakPath(
    p: FunctionInfo['exitPaths'][number],
    allocByVar: Map<string, { variable: string; line: number; callName: string }>,
  ): string {
    const allocDescr = p.unreconciledAllocations
      .map((v) => {
        const a = allocByVar.get(v);
        return a ? `\`${v}\` (${a.callName}, line ${a.line})` : `\`${v}\``;
      })
      .join(', ');
    const condClause =
      p.pathConditions.length > 0
        ? ` under condition [${p.pathConditions.join(' && ')}]`
        : '';
    return `allocation of ${allocDescr} reaches the ${p.kind} at line ${p.exitLine}${condClause} without an intervening free`;
  }

  private functionEndLine(fn: FunctionInfo, allFunctions: FunctionInfo[]): number {
    const idx = allFunctions.indexOf(fn);
    if (idx < allFunctions.length - 1) {
      return allFunctions[idx + 1].lineNumber - 1;
    }
    return fn.lineNumber + 100;
  }

  private computePathsToLine(fn: FunctionInfo, targetLine: number): string[] {
    const paths: string[] = [];
    for (const cond of fn.conditions) {
      const condLineMatch = cond.text.match(/line (\d+)/);
      const condLine = condLineMatch ? parseInt(condLineMatch[1]) : cond.line;
      if (condLine < targetLine) {
        paths.push(`path through line ${fn.conditions.indexOf(cond) + 1}: ${cond.text.slice(0, 80)}`);
      }
    }
    if (paths.length === 0) {
      paths.push('direct path (no conditions before target)');
    }
    return paths;
  }
}
