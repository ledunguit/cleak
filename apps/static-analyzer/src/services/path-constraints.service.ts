import { Injectable } from '@nestjs/common';
import { CParserService, FunctionInfo } from './c-parser.service';

@Injectable()
export class PathConstraintsService {
  constructor(private readonly cParser: CParserService) {}

  analyze(filePath: string, content: string, lineNumber: number) {
    const result = this.cParser.parse(content, filePath);

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

    return {
      constraints,
      feasiblePaths,
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
