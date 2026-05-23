import { Injectable } from '@nestjs/common';
import { LeakBundle, InvestigationVerdict, VerdictResult, ToolKind } from '@mcpvul/common';

@Injectable()
export class JudgeService {
  judgeBundle(bundle: LeakBundle): VerdictResult {
    // Heuristic-based judging (Phase 5 will add LLM-assisted judging)
    if (bundle.evidence.length >= 2) {
      return {
        verdict: InvestigationVerdict.CONFIRMED_LEAK,
        confidence: 0.85,
        explanation: `Confirmed by ${bundle.evidence.length} tools`,
        evidence: bundle.evidence.map((e) => `${e.tool}: ${e.function_name}`),
        tool: ToolKind.HEURISTIC,
      };
    }

    if (bundle.evidence.length >= 1) {
      return {
        verdict: InvestigationVerdict.LIKELY_LEAK,
        confidence: 0.65,
        explanation: `Dynamic evidence from ${bundle.evidence[0].tool}: ${bundle.evidence[0].bytes_lost} bytes lost`,
        evidence: bundle.evidence.map((e) => `${e.tool}: ${e.function_name}`),
        tool: ToolKind.HEURISTIC,
      };
    }

    if (bundle.candidate.confidence === 'high') {
      return {
        verdict: InvestigationVerdict.LIKELY_LEAK,
        confidence: 0.65,
        explanation: 'High-confidence allocation pattern detected',
        evidence: [],
        tool: ToolKind.HEURISTIC,
      };
    }

    return {
      verdict: InvestigationVerdict.UNCERTAIN,
      confidence: 0.3,
      explanation: 'Insufficient evidence',
      evidence: [],
      tool: ToolKind.HEURISTIC,
    };
  }

  judgeBundles(bundles: LeakBundle[]): Map<string, VerdictResult> {
    const results = new Map<string, VerdictResult>();
    for (const bundle of bundles) {
      results.set(bundle.bundleId, this.judgeBundle(bundle));
    }
    return results;
  }
}
