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
    }[] = [];

    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf-8');
        const result = this.cParser.parse(content, file);

        for (const fn of result.functions) {
          const ownershipType = this.inferOwnershipType(fn);
          const allocatedObjects = fn.allocationVariables.map((a) => a.variable);

          if (allocatedObjects.length > 0 || ownershipType !== 'none') {
            ownerships.push({
              functionName: fn.functionName,
              filePath: file,
              ownershipType,
              allocatedObjects,
            });
          }
        }
      } catch {
        // skip unreadable
      }
    }

    return { ownerships };
  }

  conventions(content: string, filePath: string) {
    const rules: {
      pattern: string;
      description: string;
      conventionType: string;
    }[] = [];
    const result = this.cParser.parse(content, filePath);

    for (const fn of result.functions) {
      const hasAlloc = fn.allocationCalls.length > 0;
      const hasFree = fn.deallocationCalls.length > 0;

      if (hasAlloc && !hasFree) {
        rules.push({
          pattern: `${fn.functionName} allocates but never frees`,
          description: 'Function allocates memory that may leak',
          conventionType: 'leak_risk',
        });
      }

      if (fn.allocationVariables.length > 0) {
        const freed = new Set(fn.freedVariables.map((f) => f.variable));
        for (const alloc of fn.allocationVariables) {
          if (!freed.has(alloc.variable)) {
            rules.push({
              pattern: `${alloc.variable} allocated at line ${alloc.line} but never freed`,
              description: `${alloc.variable} = ${alloc.callName}() without matching free()`,
              conventionType: 'missing_free',
            });
          }
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
  }): string {
    const allocCount = fn.allocationVariables.length;
    const freedNames = new Set(fn.freedVariables.map((f) => f.variable));
    const allocNotFreed = fn.allocationVariables.filter(
      (a) => !freedNames.has(a.variable),
    ).length;

    // Returns allocated memory -> "returns_ownership"
    if (allocNotFreed > 0) return 'returns_ownership';

    // Takes pointer and frees -> "consumes_ownership"
    const hasPointerParam = fn.parameters.some(
      (p) => p.type.includes('*'),
    );
    if (hasPointerParam && fn.freedVariables.length > 0) {
      return 'consumes_ownership';
    }

    // Allocates and frees locally -> "local_ownership"
    if (allocCount > 0 && allocNotFreed === 0) return 'local_ownership';

    return 'none';
  }
}
