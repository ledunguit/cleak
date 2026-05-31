import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import { CParserService } from './c-parser.service';

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
    };
  }
}
