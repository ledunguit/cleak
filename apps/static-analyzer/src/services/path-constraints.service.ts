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
      return { constraints: [], feasiblePaths: [] };
    }

    const constraints = containingFunction.conditions.map(
      (c) => `if (${c.text}) at line ${c.line}`,
    );

    const feasiblePaths = this.computeFeasiblePaths(
      containingFunction,
      lineNumber,
    );

    return { constraints, feasiblePaths };
  }

  private functionEndLine(fn: FunctionInfo, allFunctions: FunctionInfo[]): number {
    // Approximate: next function's line - 1, or +100
    const idx = allFunctions.indexOf(fn);
    if (idx < allFunctions.length - 1) {
      return allFunctions[idx + 1].lineNumber - 1;
    }
    return fn.lineNumber + 100;
  }

  private computeFeasiblePaths(fn: FunctionInfo, targetLine: number): string[] {
    const paths: string[] = [];
    for (const cond of fn.conditions) {
      if (cond.line < targetLine) {
        paths.push(`path through line ${cond.line}: ${cond.text}`);
      }
    }
    if (paths.length === 0) {
      paths.push('direct path (no conditions)');
    }
    return paths;
  }
}
