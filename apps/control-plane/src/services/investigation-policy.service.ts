import { Injectable } from '@nestjs/common';
import {
  LeakBundle,
  InvestigationVerdict,
  ToolKind,
} from '@mcpvul/common';

@Injectable()
export class InvestigationPolicyService {
  shouldInvestigateFurther(bundle: LeakBundle): boolean {
    if (!bundle.verdict) return true;
    return [
      InvestigationVerdict.LIKELY_LEAK,
      InvestigationVerdict.UNCERTAIN,
    ].includes(bundle.verdict.verdict as InvestigationVerdict);
  }

  selectNextTool(bundle: LeakBundle, availableTools: ToolKind[]): ToolKind | null {
    const usedTools = new Set(bundle.evidence.map((e) => e.tool));
    const unused = availableTools.filter((t) => !usedTools.has(t));

    if (unused.length === 0) return null;

    // Prefer dynamic tools over static
    const dynamicTools = unused.filter((t) =>
      [ToolKind.VALGRIND, ToolKind.ASAN, ToolKind.LSAN].includes(t),
    );
    if (dynamicTools.length > 0) return dynamicTools[0];

    return unused[0];
  }
}
