import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import { CParserService } from './c-parser.service';

@Injectable()
export class InterproceduralFlowService {
  constructor(private readonly cParser: CParserService) {}

  analyze(rootPath: string, functionName: string, files: string[]) {
    const paths: { functionName: string; filePath: string; lines: number[] }[] = [];
    const visited = new Set<string>();

    this.traceCalls(functionName, files, visited, paths);

    return { paths };
  }

  private traceCalls(
    fnName: string,
    files: string[],
    visited: Set<string>,
    paths: { functionName: string; filePath: string; lines: number[] }[],
  ) {
    if (visited.has(fnName)) return;
    visited.add(fnName);

    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf-8');
        const result = this.cParser.parse(content, file);

        for (const fn of result.functions) {
          if (fn.functionName === fnName) {
            const lines = fn.allocationCalls
              .concat(fn.deallocationCalls)
              .map((c) => c.line);

            paths.push({
              functionName: fnName,
              filePath: file,
              lines: [...new Set(lines)].sort((a, b) => a - b),
            });

            // Trace calls made by this function
            for (const call of fn.functionCalls) {
              this.traceCalls(call.name, files, visited, paths);
            }
          }
        }
      } catch {
        // skip unreadable
      }
    }
  }
}
