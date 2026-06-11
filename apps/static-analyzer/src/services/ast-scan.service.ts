import { Injectable, Logger } from '@nestjs/common';
import { CParserService, FunctionInfo, ControlFlowGraph, ExitPathAnalysis, LoopInfo } from './c-parser.service';
import { readFileSync } from 'fs';

const ALLOC_FUNCS = new Set([
  'malloc', 'calloc', 'realloc', 'strdup', 'strndup',
  'xmalloc', 'xcalloc', 'xrealloc', 'xstrdup',
  'kmalloc', 'kcalloc', 'kzalloc', 'vmalloc',
]);

const FREE_FUNCS = new Set(['free', 'xfree', 'kfree', 'vfree']);

export interface MemoryPattern {
  patternType: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  functionName: string;
  filePath: string;
  lineNumber: number;
  description: string;
  explanation: string;
  allocationType: string;
  allocationVariable?: string;
  allocationLine?: number;
  suggestedFix?: string;
}

export interface ScanResult {
  patterns: MemoryPattern[];
  functionSummaries: FunctionSummary[];
}

export interface FunctionSummary {
  functionName: string;
  filePath: string;
  lineNumber: number;
  totalAllocs: number;
  totalFrees: number;
  allocFreeRatio: number;
  hasLeakPatterns: boolean;
  patternCount: number;
  earlyReturnCount: number;
  loopCount: number;
  loopsWithAllocations: number;
  exitPathCount: number;
  leakyExitPaths: number;
  confidence: 'high' | 'medium' | 'low';
}

@Injectable()
export class AstScanService {
  private readonly logger = new Logger(AstScanService.name);

  constructor(private readonly cParser: CParserService) {}

  parse(filePath: string, content?: string): ScanResult {
    const source = content || readFileSync(filePath, 'utf-8');
    const parseResult = this.cParser.parse(source, filePath);
    const patterns: MemoryPattern[] = [];
    const summaries: FunctionSummary[] = [];

    for (const fn of parseResult.functions) {
      // Pattern 1: Early Return Leak (allocation before return without free)
      patterns.push(...this.detectEarlyReturnLeaks(fn, filePath));

      // Pattern 2: Loop-accumulated leak (allocation in loop without free in loop)
      patterns.push(...this.detectLoopLeaks(fn, filePath));

      // Pattern 3: Conditional leak (allocation in if-branch, not freed in else/no-free-on-path)
      patterns.push(...this.detectConditionalLeaks(fn, filePath));

      // Pattern 4: strdup without free
      patterns.push(...this.detectStrdupLeaks(fn, filePath));

      // Pattern 5: realloc mishandling (not checking return value)
      patterns.push(...this.detectReallocMishandling(fn, filePath));

      // Pattern 6: Missing NULL check after allocation
      patterns.push(...this.detectMissingNullCheck(fn, filePath));

      // Pattern 7: Struct field allocation without free
      patterns.push(...this.detectStructFieldLeaks(fn, filePath));

      // Pattern 8: Combined exit path analysis (from CFG)
      patterns.push(...this.detectExitPathLeaks(fn, filePath));

      // Build summary
      const totalAllocs = fn.allocationCalls.length;
      const totalFrees = fn.deallocationCalls.length;
      const leakyPaths = fn.exitPaths.filter((p) => p.leakRisk !== 'none');
      const loopsWithAlloc = fn.loops.filter((l) => l.bodyHasAllocation);
      const fnPatterns = patterns.filter((p) => p.functionName === fn.functionName);

      summaries.push({
        functionName: fn.functionName,
        filePath,
        lineNumber: fn.lineNumber,
        totalAllocs,
        totalFrees,
        allocFreeRatio: totalAllocs > 0 ? totalFrees / totalAllocs : 1,
        hasLeakPatterns: fnPatterns.length > 0,
        patternCount: fnPatterns.length,
        earlyReturnCount: fn.returnStatements.length,
        loopCount: fn.loops.length,
        loopsWithAllocations: loopsWithAlloc.length,
        exitPathCount: fn.exitPaths.length,
        leakyExitPaths: leakyPaths.length,
        confidence: this.computeConfidence(fnPatterns, fn),
      });
    }

    return { patterns, functionSummaries: summaries };
  }

  // ═══════════════════════════════════════════
  // PATTERN 1: Early Return Leak
  // ═══════════════════════════════════════════

  private detectEarlyReturnLeaks(fn: FunctionInfo, filePath: string): MemoryPattern[] {
    const patterns: MemoryPattern[] = [];
    if (fn.allocationVariables.length === 0) return patterns;

    for (const ret of fn.returnStatements) {
      // Find allocation variables before this return
      const allocVarsBefore = fn.allocationVariables.filter(
        (av) => av.line < ret.line,
      );
      if (allocVarsBefore.length === 0) continue;

      // Find freed variables before this return
      const freedVarsBefore = fn.freedVariables.filter(
        (fv) => fv.line < ret.line,
      );
      const freedVarSet = new Set(freedVarsBefore.map((fv) => fv.variable));

      // Variables that were allocated but not freed before this return
      const leakedVars = allocVarsBefore.filter(
        (av) => !freedVarSet.has(av.variable),
      );

      if (leakedVars.length > 0) {
        const allocTypes = [...new Set(leakedVars.map((v) => v.callName))].join(', ');
        const varNames = leakedVars.map((v) => v.variable).join(', ');

        patterns.push({
          patternType: 'early_return_leak',
          severity: 'high',
          functionName: fn.functionName,
          filePath,
          lineNumber: ret.line,
          description: `Early return at line ${ret.line} before freeing ${varNames}`,
          explanation: `Function allocates memory (${allocTypes}) and returns at line ${ret.line} without releasing it on this path. The allocation happened at line(s) ${leakedVars.map((v) => v.line).join(', ')}.`,
          allocationType: allocTypes,
          allocationVariable: varNames,
          allocationLine: leakedVars[0]?.line,
          suggestedFix: `Add free(${varNames}) before return at line ${ret.line}, or restructure to use a single-exit cleanup pattern.`,
        });
      }
    }

    return patterns;
  }

  // ═══════════════════════════════════════════
  // PATTERN 2: Loop-Accumulated Leak
  // ═══════════════════════════════════════════

  private detectLoopLeaks(fn: FunctionInfo, filePath: string): MemoryPattern[] {
    const patterns: MemoryPattern[] = [];

    for (const loop of fn.loops) {
      if (loop.bodyHasAllocation && !loop.bodyHasFree) {
        patterns.push({
          patternType: 'loop_accumulate_leak',
          severity: 'critical',
          functionName: fn.functionName,
          filePath,
          lineNumber: loop.line,
          description: `Loop allocates memory but never frees inside loop body`,
          explanation: `The ${loop.kind} loop at line ${loop.line} contains malloc/calloc/strdup call(s) but has no matching free() inside the loop. Each iteration leaks memory. Variables: ${loop.allocationVariables.join(', ') || '(tracking failed)'}.`,
          allocationType: 'malloc/calloc',
          allocationVariable: loop.allocationVariables.join(', '),
          allocationLine: loop.line,
          suggestedFix: `Move the allocation outside the loop, or add free() at the end of each loop iteration to release memory before the next iteration.`,
        });
      }
    }

    return patterns;
  }

  // ═══════════════════════════════════════════
  // PATTERN 3: Conditional Leak
  // ═══════════════════════════════════════════

  private detectConditionalLeaks(fn: FunctionInfo, filePath: string): MemoryPattern[] {
    const patterns: MemoryPattern[] = [];

    for (const exitPath of fn.exitPaths) {
      if (exitPath.leakRisk === 'high' || exitPath.leakRisk === 'medium') {
        const pathVars = exitPath.unreconciledAllocations;
        if (pathVars.length === 0) continue;

        patterns.push({
          patternType: 'conditional_leak',
          severity: exitPath.leakRisk === 'high' ? 'high' : 'medium',
          functionName: fn.functionName,
          filePath,
          lineNumber: exitPath.exitLine,
          description: `Exit path at line ${exitPath.exitLine} does not free all allocations`,
          explanation: `On the ${exitPath.kind} exit path at line ${exitPath.exitLine}, the following allocated variables are not freed: ${pathVars.join(', ')}. Path conditions: ${exitPath.pathConditions.join('; ') || 'unconditional'}.`,
          allocationType: 'malloc',
          allocationVariable: pathVars.join(', '),
          allocationLine: fn.allocationVariables.find((av) => pathVars.includes(av.variable))?.line || 0,
          suggestedFix: `Ensure free(${pathVars.join(', ')}) is called before this ${exitPath.kind} at line ${exitPath.exitLine}. Consider using a goto cleanup pattern.`,
        });
      }
    }

    return patterns;
  }

  // ═══════════════════════════════════════════
  // PATTERN 4: strdup Without Free
  // ═══════════════════════════════════════════

  private detectStrdupLeaks(fn: FunctionInfo, filePath: string): MemoryPattern[] {
    const patterns: MemoryPattern[] = [];

    const strdupCalls = fn.allocationVariables.filter(
      (av) => av.callName === 'strdup' || av.callName === 'strndup',
    );

    for (const alloc of strdupCalls) {
      const freed = fn.freedVariables.some(
        (fv) => fv.variable === alloc.variable,
      );
      if (!freed) {
        patterns.push({
          patternType: 'strdup_leak',
          severity: 'high',
          functionName: fn.functionName,
          filePath,
          lineNumber: alloc.line,
          description: `strdup() result not freed: ${alloc.variable}`,
          explanation: `strdup() allocates memory internally via malloc(). The variable '${alloc.variable}' is assigned a strdup result at line ${alloc.line} but free() is never called for it in this function.`,
          allocationType: 'strdup',
          allocationVariable: alloc.variable,
          allocationLine: alloc.line,
          suggestedFix: `Add free(${alloc.variable}) after the last use, or use a smart pointer / std::string in C++.`,
        });
      }
    }

    return patterns;
  }

  // ═══════════════════════════════════════════
  // PATTERN 5: realloc Mishandling
  // ═══════════════════════════════════════════

  private detectReallocMishandling(fn: FunctionInfo, filePath: string): MemoryPattern[] {
    const patterns: MemoryPattern[] = [];

    const reallocCalls = fn.functionCalls.filter((c) => c.name === 'realloc');
    for (const rc of reallocCalls) {
      patterns.push({
        patternType: 'realloc_mishandle',
        severity: 'medium',
        functionName: fn.functionName,
        filePath,
        lineNumber: rc.line,
        description: `realloc() at line ${rc.line}: losing original pointer on failure`,
        explanation: `realloc() returns NULL on failure, overwriting the original pointer. Use a temporary variable: tmp = realloc(ptr, new_size); if (!tmp) { /* handle error */ } ptr = tmp;`,
        allocationType: 'realloc',
        allocationLine: rc.line,
        suggestedFix: `Replace with: void *tmp = realloc(ptr, new_size); if (!tmp) { free(ptr); return error; } ptr = tmp;`,
      });
    }

    return patterns;
  }

  // ═══════════════════════════════════════════
  // PATTERN 6: Missing NULL Check
  // ═══════════════════════════════════════════

  private detectMissingNullCheck(fn: FunctionInfo, filePath: string): MemoryPattern[] {
    const patterns: MemoryPattern[] = [];

    // For each allocation, check if there's a NULL check in the 3 lines after
    for (const alloc of fn.allocationVariables) {
      const lineAfterAlloc = alloc.line + 1;
      const nullCheckExists = fn.conditions.some(
        (c) => c.line >= alloc.line && c.line <= alloc.line + 4 &&
          (c.text.includes(`${alloc.variable} == NULL`) ||
           c.text.includes(`${alloc.variable} != NULL`) ||
           c.text.includes(`!${alloc.variable}`)),
      );

      if (!nullCheckExists) {
        patterns.push({
          patternType: 'missing_null_check',
          severity: 'medium',
          functionName: fn.functionName,
          filePath,
          lineNumber: alloc.line,
          description: `No NULL check after ${alloc.callName}(${alloc.variable}) at line ${alloc.line}`,
          explanation: `Allocation via ${alloc.callName}() may return NULL. The code does not check '${alloc.variable}' for NULL before use. This can lead to NULL pointer dereference.`,
          allocationType: alloc.callName,
          allocationVariable: alloc.variable,
          allocationLine: alloc.line,
          suggestedFix: `Add: if (!${alloc.variable}) { /* handle error */ } after the allocation.`,
        });
      }
    }

    return patterns;
  }

  // ═══════════════════════════════════════════
  // PATTERN 7: Struct Field Allocation Leak
  // ═══════════════════════════════════════════

  private detectStructFieldLeaks(fn: FunctionInfo, filePath: string): MemoryPattern[] {
    const patterns: MemoryPattern[] = [];

    const structAllocs = fn.allocationVariables.filter(
      (av) => av.variable.includes('->') || av.variable.includes('.'),
    );

    for (const alloc of structAllocs) {
      const freed = fn.freedVariables.some(
        (fv) => fv.variable === alloc.variable ||
          alloc.variable.startsWith(fv.variable),
      );

      if (!freed) {
        patterns.push({
          patternType: 'struct_field_leak',
          severity: 'high',
          functionName: fn.functionName,
          filePath,
          lineNumber: alloc.line,
          description: `Struct field '${alloc.variable}' allocated but never freed`,
          explanation: `Memory is allocated for struct field '${alloc.variable}' at line ${alloc.line} via ${alloc.callName}(), but the field is never freed. The struct may need a destructor/cleanup function.`,
          allocationType: alloc.callName,
          allocationVariable: alloc.variable,
          allocationLine: alloc.line,
          suggestedFix: `Ensure a matching free(${alloc.variable}) is called when the struct is destroyed, or use a smart pointer member.`,
        });
      }
    }

    return patterns;
  }

  // ═══════════════════════════════════════════
  // PATTERN 8: Exit Path Analysis from CFG
  // ═══════════════════════════════════════════

  private detectExitPathLeaks(fn: FunctionInfo, filePath: string): MemoryPattern[] {
    const patterns: MemoryPattern[] = [];

    for (const path of fn.exitPaths) {
      if (path.leakRisk === 'high' && path.unreconciledAllocations.length > 0) {
        const alreadyReported = patterns.some(
          (p) => p.lineNumber === path.exitLine && p.patternType === 'early_return_leak',
        );
        if (!alreadyReported) {
          patterns.push({
            patternType: 'interprocedural_leak',
            severity: path.leakRisk === 'high' ? 'high' : 'medium',
            functionName: fn.functionName,
            filePath,
            lineNumber: path.exitLine,
            description: `${path.kind} at line ${path.exitLine} leaks ${path.unreconciledAllocations.join(', ')}`,
            explanation: `Exit via ${path.kind} at line ${path.exitLine} loses ${path.unreconciledAllocations.length} allocated variable(s): ${path.unreconciledAllocations.join(', ')}. Free calls on this path: ${path.freeLinesOnPath.join(', ') || 'none'}.`,
            allocationType: 'malloc/strdup',
            allocationVariable: path.unreconciledAllocations.join(', '),
            allocationLine: fn.allocationVariables.find((av) => path.unreconciledAllocations.includes(av.variable))?.line || 0,
            suggestedFix: `Ensure all allocated variables are freed before this exit point. Consider refactoring to single-exit cleanup using goto cleanup pattern.`,
          });
        }
      }
    }

    return patterns;
  }

  // ═══════════════════════════════════════════
  // HELPER: Confidence computation
  // ═══════════════════════════════════════════

  private computeConfidence(
    patterns: MemoryPattern[],
    fn: FunctionInfo,
  ): 'high' | 'medium' | 'low' {
    if (patterns.length === 0) return 'low';
    if (patterns.some((p) => p.severity === 'critical')) return 'high';
    if (patterns.some((p) => p.severity === 'high')) return 'high';
    if (patterns.length >= 3) return 'high';

    // Check if there's a clear alloc-without-free pattern
    if (fn.allocationCalls.length > 0 && fn.deallocationCalls.length === 0) {
      return 'high';
    }

    if (patterns.length >= 1) return 'medium';
    return 'low';
  }
}
