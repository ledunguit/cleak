import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import { CParserService } from './c-parser.service';

@Injectable()
export class CallGraphService {
  constructor(private readonly cParser: CParserService) {}

  extract(rootPath: string, files: string[]) {
    const allFunctions: Map<string, string> = new Map();
    const callEdges: { caller: string; callee: string; filePath: string; lineNumber: number }[] = [];

    // First pass: collect all internal function names
    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf-8');
        const result = this.cParser.parse(content, file);
        for (const fn of result.functions) {
          allFunctions.set(fn.functionName, file);
        }
      } catch {
        // skip unreadable files
      }
    }

    // Second pass: build edges
    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf-8');
        const result = this.cParser.parse(content, file);
        for (const fn of result.functions) {
          for (const call of fn.functionCalls) {
            callEdges.push({
              caller: fn.functionName,
              callee: call.name,
              filePath: file,
              lineNumber: call.line,
            });
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    const nodes = Array.from(allFunctions.entries()).map(([name, file]) => ({
      functionName: name,
      filePath: file,
    }));

    return { edges: callEdges, nodes };
  }
}
