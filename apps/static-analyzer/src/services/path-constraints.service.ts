import { Injectable } from '@nestjs/common';
import { FeasibleLeakPath } from '@cleak/common';
import { CParserService, FunctionInfo } from './c-parser.service';
import { leakFeasible } from './feasibility';

@Injectable()
export class PathConstraintsService {
  constructor(private readonly cParser: CParserService) {}

  async analyze(filePath: string, content: string, lineNumber: number, extraAllocators?: string[], extraDeallocators?: string[]) {
    const result = this.cParser.parse(content, filePath, extraAllocators, extraDeallocators);

    // Innermost enclosing function by the ACCURATE tree-sitter range (fn.endLine),
    // not the old "next function − 1" heuristic — picks the smallest range on nesting.
    const containingFunction = result.functions
      .filter((fn) => fn.lineNumber <= lineNumber && this.functionEndLine(fn, result.functions) >= lineNumber)
      .sort((a, b) => this.functionEndLine(a, result.functions) - a.lineNumber - (this.functionEndLine(b, result.functions) - b.lineNumber))[0];

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
    const feasibleLeakPaths = await this.buildFeasibleLeakPaths(containingFunction);

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

  private async buildFeasibleLeakPaths(fn: FunctionInfo): Promise<FeasibleLeakPath[]> {
    const allocByVar = new Map(
      fn.allocationVariables.map((a) => [a.variable, a]),
    );

    const candidates = fn.exitPaths.filter(
      (p) => p.reachableFromEntry && p.leakRisk !== 'none' && p.unreconciledAllocations.length > 0,
    );

    const out: FeasibleLeakPath[] = [];
    for (const p of candidates) {
      // Z3-FILTER each unreconciled var against this exit's branch guards: a leak of
      // `v` is impossible when (v != 0) contradicts the guards (e.g. an early
      // `if (v == NULL) return;`). Drop infeasible vars; drop the whole path if every
      // candidate leak on it is infeasible. `unknown` (Z3 off / untranslatable guards)
      // keeps the var — never lose a real leak to the solver.
      let z3Ran = false;
      const live: string[] = [];
      for (const v of p.unreconciledAllocations) {
        const verdict = await leakFeasible(v, p.guards);
        if (verdict !== 'unknown') z3Ran = true;
        if (verdict !== 'infeasible') live.push(v);
      }
      if (live.length === 0) continue;
      out.push({
        kind: p.kind,
        exitLine: p.exitLine,
        reachable: p.reachableFromEntry,
        conditions: p.pathConditions,
        unreconciledAllocations: live,
        leakRisk: p.leakRisk,
        narrative: this.describeLeakPath({ ...p, unreconciledAllocations: live }, allocByVar),
        feasibilityChecked: z3Ran ? ('z3' as const) : ('heuristic' as const),
      });
    }
    return out;
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
    // Prefer the real closing-brace line from tree-sitter; fall back to the old
    // "next function − 1 / +100" estimate only when endLine is absent (defensive).
    if (fn.endLine && fn.endLine >= fn.lineNumber) return fn.endLine;
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
