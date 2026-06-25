import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import { AllocFreePair } from '@cleak/common';
import { CParserService, FunctionInfo } from './c-parser.service';

@Injectable()
export class FunctionSummaryService {
  constructor(private readonly cParser: CParserService) {}

  summarize(filePath: string, content?: string, functionName?: string) {
    const source = content || readFileSync(filePath, 'utf-8');
    const result = this.cParser.parse(source, filePath);

    const functions = result.functions.filter(
      (fn) => !functionName || fn.functionName === functionName,
    );

    const summaries = functions.map((fn) => {
      const freedVarNames = new Set(fn.freedVariables.map((f) => f.variable));
      const leakedVariables = fn.allocationVariables.filter(
        (a) => !freedVarNames.has(a.variable),
      );
      const nonlocalAllocations = fn.allocationVariables.filter(
        (a) =>
          !fn.localVariables.some((v) => v.name === a.variable) &&
          !fn.parameters.some((p) => p.name === a.variable),
      );

      // Enhanced analysis
      const leakyPaths = fn.exitPaths.filter((p) => p.leakRisk !== 'none');
      const loopsWithAlloc = fn.loops.filter((l) => l.bodyHasAllocation);

      return {
        function_name: fn.functionName,
        parameter_count: fn.parameters.length,
        local_variable_count: fn.localVariables.length,
        call_count: fn.functionCalls.length,
        allocation_count: fn.allocationCalls.length,
        deallocation_count: fn.deallocationCalls.length,
        return_count: fn.returnStatements.length,
        leaked_variables: leakedVariables,
        nonlocal_allocations: nonlocalAllocations,
        has_allocation_without_local_free: leakedVariables.length > 0,
        // New enhanced fields
        exit_path_count: fn.exitPaths.length,
        leaky_exit_paths: leakyPaths.length,
        loop_count: fn.loops.length,
        loops_with_allocations: loopsWithAlloc.length,
        gotos: fn.gotoTargets.length,
        severtiy: leakedVariables.length > 0 ? 'high' : (leakyPaths.length > 0 ? 'medium' : 'low'),
      };
    });

    const specific = functionName
      ? summaries[0] || null
      : summaries;

    return {
      summary: JSON.stringify(specific),
      allocations: functions.flatMap((f) =>
        f.allocationCalls.map((a) => `${a.name} at line ${a.line}`),
      ),
      frees: functions.flatMap((f) =>
        f.deallocationCalls.map((d) => `${d.name} at line ${d.line}`),
      ),
      // Alloc→free site pairing (LAMeD): each allocation paired with its free
      // (or null when unpaired), plus the "binds to a new variable" post-filter.
      pairs: functions.flatMap((f) => this.pairAllocFree(f, filePath)),
    };
  }

  /** Pair each allocation with its matching free (by variable), classify status. */
  private pairAllocFree(fn: FunctionInfo, filePath: string): AllocFreePair[] {
    // Variables left un-freed on at least one reachable exit path → conditional/unpaired.
    const unreconciled = new Set<string>();
    for (const p of fn.exitPaths) {
      for (const v of p.unreconciledAllocations) unreconciled.add(v);
    }

    return fn.allocationVariables.map((alloc) => {
      const free = fn.freedVariables.find((free) => free.variable === alloc.variable);
      const freeLine = free?.line ?? null;
      const freeFunction =
        free != null
          ? fn.deallocationCalls.find((d) => d.line === free.line)?.name ?? 'free'
          : null;

      let status: AllocFreePair['status'];
      if (freeLine == null) {
        status = 'unpaired';
      } else if (unreconciled.has(alloc.variable)) {
        // Freed somewhere, but at least one reachable exit leaves it un-freed.
        status = 'conditional';
      } else {
        status = 'paired';
      }

      // LAMeD post-filter: a fresh local declaration (not a struct field / existing object).
      const bindsToNewVariable =
        !alloc.variable.includes('->') &&
        !alloc.variable.includes('.') &&
        fn.localVariables.some((v) => v.name === alloc.variable);

      return {
        variable: alloc.variable,
        allocCall: alloc.callName,
        allocLine: alloc.line,
        allocFile: filePath,
        freeLine,
        freeFunction,
        bindsToNewVariable,
        status,
      };
    });
  }
}
