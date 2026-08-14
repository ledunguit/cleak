import { Injectable, Logger } from '@nestjs/common';
import { FeasibleLeakPath } from '@cleak/common';
import { ServerEventName } from '@cleak/common/mcp/server-events';
import { CParserService, FunctionInfo } from './c-parser.service';

@Injectable()
export class PathConstraintsService {
  private readonly logger = new Logger(PathConstraintsService.name);

  constructor(private readonly cParser: CParserService) {}

  async analyze(filePath: string, content: string, lineNumber: number, extraAllocators?: string[], extraDeallocators?: string[]) {
    this.logger.log({ event: ServerEventName.PATH_CONSTRAINTS_STARTED, filePath, lineNumber }, 'path constraints started');
    const result = await this.cParser.parse(content, filePath, extraAllocators, extraDeallocators);
    const functions = result.functions;

    // Precompute each function's effective end line in ONE O(F) pass — the old
    // filter/sort re-ran functionEndLine() per comparison, and its indexOf fallback
    // re-scanned the whole function list per call (O(F²) worst case).
    const endLines = this.computeEndLines(functions);

    // Innermost enclosing function by the ACCURATE tree-sitter range (fn.endLine),
    // not the old "next function − 1" heuristic — picks the smallest range on nesting.
    // Single O(F) pass over the precomputed spans; first-in-order wins on equal span
    // (the old version sorted by span ascending with a stable sort).
    let containingFunction: FunctionInfo | undefined;
    let bestSpan = Infinity;
    for (let i = 0; i < functions.length; i++) {
      const fn = functions[i];
      if (fn.lineNumber <= lineNumber && endLines[i] >= lineNumber) {
        const span = endLines[i] - fn.lineNumber;
        if (span < bestSpan) {
          bestSpan = span;
          containingFunction = fn;
        }
      }
    }

    if (!containingFunction) {
      this.logger.log({ event: ServerEventName.PATH_CONSTRAINTS_FINISHED, filePath, lineNumber, containingFunction: null }, 'no enclosing function at line');
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

    this.logger.log(
      { event: ServerEventName.PATH_CONSTRAINTS_FINISHED, filePath, lineNumber, containingFunction: containingFunction.functionName, feasibleLeakPathCount: feasibleLeakPaths.length },
      'path constraints finished',
    );
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

    // Heuristic CFG exit-path analysis: a reachable exit that leaves an allocation
    // un-freed is a candidate leak path. The paths are already guard-subset
    // reconciled by the C parser (a free under a matching guard cancels the alloc);
    // we emit the survivors as-is. There is NO SMT path-feasibility filter — Z3 was
    // removed from the architecture (its WASM build OOMs on recursive real-project
    // functions, and the only peer-reviewed leak baseline, LAMeD, is solver-free).
    // This over-reports NULL-guarded early returns, so STATIC_ENRICH stays opt-in.
    const candidates = fn.exitPaths.filter(
      (p) => p.reachableFromEntry && p.leakRisk !== 'none' && p.unreconciledAllocations.length > 0,
    );

    return candidates.map((p) => ({
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

  /**
   * Effective closing line per function, in `functions` order: the real tree-sitter
   * endLine when present, else "next function − 1", else (line + 100) — the exact
   * rule functionEndLine() used to apply via indexOf, now computed in one O(F) pass.
   */
  private computeEndLines(functions: FunctionInfo[]): number[] {
    const endLines: number[] = new Array(functions.length);
    for (let i = 0; i < functions.length; i++) {
      const fn = functions[i];
      if (fn.endLine && fn.endLine >= fn.lineNumber) {
        endLines[i] = fn.endLine;
      } else if (i < functions.length - 1) {
        endLines[i] = functions[i + 1].lineNumber - 1;
      } else {
        endLines[i] = fn.lineNumber + 100;
      }
    }
    return endLines;
  }

  private computePathsToLine(fn: FunctionInfo, targetLine: number): string[] {
    const paths: string[] = [];
    const conditions = fn.conditions;
    // Index-based single pass — the old loop called conditions.indexOf(cond) on the
    // array it was iterating, O(C²). indexOf returned the element's own index (each
    // condition appears once), so `i + 1` reproduces the same path label.
    for (let i = 0; i < conditions.length; i++) {
      const cond = conditions[i];
      const condLineMatch = cond.text.match(/line (\d+)/);
      const condLine = condLineMatch ? parseInt(condLineMatch[1]) : cond.line;
      if (condLine < targetLine) {
        paths.push(`path through line ${i + 1}: ${cond.text.slice(0, 80)}`);
      }
    }
    if (paths.length === 0) {
      paths.push('direct path (no conditions before target)');
    }
    return paths;
  }
}
