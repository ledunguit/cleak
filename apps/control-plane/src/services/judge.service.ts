import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LeakBundle,
  InvestigationVerdict,
  VerdictResult,
  ToolKind,
  LeakPatternType,
  LeakRootCause,
  LeakExplanation,
  ControlFlowInfo,
  ExitPathInfo,
  RepairDiff,
} from '@mcpvul/common';
import { existsSync, readFileSync } from 'fs';
import { judgeHeuristically, enrichLeakVerdict } from '@mcpvul/common/analysis/heuristic-judge';
import { enclosingFunctionSnippet } from '@mcpvul/common/analysis/judge-shared';
import { VerdictSchema, parseJsonWith } from './llm-schemas';

@Injectable()
export class JudgeService {
  private readonly logger = new Logger(JudgeService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Judge a single bundle using LLM (if available) or heuristic fallback.
   */
  async judgeBundle(
    bundle: LeakBundle,
    staticContext?: Record<string, any>,
    analysisMode?: string,
  ): Promise<VerdictResult> {
    // Only use the LLM judge in llm_assisted mode; no_llm uses the heuristic
    // judge exclusively so the two modes stay cleanly comparable.
    let verdict: VerdictResult | null = null;
    if (analysisMode === 'llm_assisted') {
      try {
        verdict = await this.judgeWithLlm(bundle, staticContext);
        if (verdict) {
          this.logger.log(`[JUDGE] LLM verdict for ${bundle.bundleId}: ${verdict.verdict} (${(verdict.confidence * 100).toFixed(0)}%)`);
        }
      } catch (err: any) {
        this.logger.warn(`[JUDGE] LLM failed for ${bundle.bundleId}, falling back to heuristic: ${err.message}`);
        verdict = null;
      }
    }

    // Heuristic judging (and the only judge path in no_llm mode). Shared with
    // the leak-inspector-tui via @mcpvul/common/analysis so both produce
    // byte-identical verdicts.
    if (!verdict) {
      // In llm_assisted mode a heuristic verdict means the LLM never produced one
      // (missing key / dead gateway / parse failure). Warn LOUDLY so an evaluation
      // can't silently report heuristic numbers under the llm_assisted label —
      // the verdict's `tool: HEURISTIC` is the machine-readable signal of this.
      if (analysisMode === 'llm_assisted') {
        this.logger.warn(
          `[JUDGE] llm_assisted fell back to HEURISTIC for ${bundle.bundleId} ` +
            `(no LLM verdict produced; check ${this.config.get('JUDGE_LLM_PROVIDER', this.config.get('LLM_PROVIDER', 'anthropic'))} key/gateway). ` +
            `This verdict does NOT reflect the LLM.`,
        );
      }
      verdict = judgeHeuristically(bundle, staticContext);
    }

    // Every leak verdict that leaves the judge carries a root-cause explanation
    // AND an applicable (source-anchored) repair diff — filling whatever the
    // heuristic path omits and whatever the LLM omits or produces as a diff that
    // no longer matches the real source.
    return enrichLeakVerdict(bundle, staticContext, verdict);
  }

  /**
   * LLM-powered judging with explanation and repair suggestion.
   */
  private async judgeWithLlm(
    bundle: LeakBundle,
    staticContext?: Record<string, any>,
  ): Promise<VerdictResult | null> {
    const provider = this.config.get<string>('JUDGE_LLM_PROVIDER', this.config.get<string>('LLM_PROVIDER', 'anthropic'));
    // Each provider has its OWN key variable so the real OpenAI key and the
    // local-gateway key never collide: local → LOCAL_LLM_API_KEY, openai →
    // OPENAI_API_KEY, anthropic → ANTHROPIC_API_KEY. No key → fall back to heuristic.
    const apiKey = this.judgeApiKey(provider);
    if (!apiKey) return null;

    const codeSnippet = this.readContextSnippet(bundle.candidate.file_path, bundle.candidate.line_number);
    const evidenceSummary = bundle.evidence
      .map((e) => {
        const kind = e.leakKind ? ` ${e.leakKind}` : '';
        const link =
          e.correlatedToCandidate
            ? ' — LINKED to this candidate'
            : e.correlationMethod === 'file_only'
              ? ' — same file, different site'
              : '';
        return `  - ${e.tool}:${kind} ${e.function_name} at ${e.file_path}:${e.line_number} (${e.bytes_lost} bytes / ${e.blocks_lost} blocks, severity: ${e.severity})${link}`;
      })
      .join('\n');

    const ctxSummary = this.renderStaticContext(bundle, staticContext);

    const systemPrompt = `You are an expert C/C++ memory leak detection analyst.

A memory leak investigation has produced evidence about a potential leak.
Your job is to analyze the evidence and produce a verdict with explanation.

ANALYZE THE FOLLOWING:
1. The allocation site (file, line, function, allocation type)
2. The code snippet around the allocation
3. Static analysis context (free status, paths, ownership)
4. Dynamic analysis evidence (if any)

PRODUCE A VERDICT:
- confirmed_leak: Clear evidence that memory is allocated but never freed on at least one execution path
- likely_leak: Strong evidence but some uncertainty (e.g., ownership might be transferred)
- uncertain: Insufficient evidence to determine
- likely_false_positive: Evidence suggests this is intentional or handled
- false_positive: Clearly not a leak (e.g., global/static allocation)

CALIBRATE using the evidence, in priority order:
- A runtime leak (valgrind/asan/lsan) whose allocation site is LINKED to this candidate is decisive (confirmed_leak, confidence >= 0.9). Weight by leak kind: definitely_lost / asan_leak => decisive; possibly_lost => weak; still_reachable => usually benign, lean false_positive.
- A runtime finding in the SAME FILE but a DIFFERENT site (not linked) is weak corroboration only.
- A CLEAN sanitizer/valgrind run that EXERCISED this allocation and reported NO leak here is strong evidence this is NOT a leak => lean false_positive / likely_false_positive (unless a runtime leak is LINKED to this very allocation).
- Ownership: if the allocation is returned to the caller or its pointer is handed off, freeing it is the caller's job => likely false_positive here. An UNPAIRED alloc->free with a reachable leak path and no ownership transfer => confirmed_leak.
- Freed on all paths / static-global => false_positive.
- Control flow is concrete, not hypothetical: a constant or scaffolding global such as if(1)/if(0) or globalReturnsTrue() does NOT change between two checks in the SAME function — if(1) always runs and if(0) is dead code. If the buffer is freed under the same condition it was allocated (or in the else of a constant if), it IS freed. Do NOT call a leak just because the free() sits in a different block, behind a constant condition, or after a break/in a second loop — trace whether it actually executes.

For confirmed_leak and likely_leak, your response MUST include:
1. The root cause: what pattern caused the leak
2. A clear explanation of WHY it leaks (which path, what happens)
3. A concrete repair suggestion with code

Respond with a JSON object ONLY. Use this exact format:
{
  "verdict": "confirmed_leak | likely_leak | uncertain | likely_false_positive | false_positive",
  "confidence": 0.0-1.0,
  "explanation": "Detailed explanation of why this is or isn't a leak",
  "evidence": ["key evidence point 1", "key evidence point 2"],
  "tool": "llm",
  "repair_suggestion": "Concrete suggestion for fixing the leak",
  "rootCause": {
    "patternType": "early_return | conditional_leak | loop_accumulate | double_free | use_after_free | strdup_leak | struct_field_leak | realloc_mishandle | missing_null_check | interprocedural_leak | unknown",
    "description": "Short description of the root cause pattern",
    "allocationFunction": "name of function that allocates",
    "allocationLine": 123,
    "allocationFile": "path/to/file.c",
    "rootCauseFunction": "function where the leak actually occurs",
    "rootCauseLine": 123,
    "rootCauseDescription": "Why the leak happens"
  },
  "repairDiff": {
    "filePath": "path/to/file.c",
    "originalLines": ["code line 1", "code line 2"],
    "suggestedLines": ["fixed code line 1", "fixed code line 2"],
    "startLine": 120,
    "description": "What the fix does"
  }
}`;

    const userMessage = `ALLOCATION SITE:
- Bundle ID: ${bundle.bundleId}
- Function: ${bundle.candidate.function_name}
- File: ${bundle.candidate.file_path}
- Line: ${bundle.candidate.line_number}
- Allocation type: ${bundle.candidate.allocation_type}
- Confidence: ${bundle.candidate.confidence}

CODE SNIPPET (context around allocation):
\`\`\`c
${codeSnippet}
\`\`\`

STATIC ANALYSIS CONTEXT:
${ctxSummary}

DYNAMIC EVIDENCE (${bundle.evidence.length} item(s)):
${evidenceSummary || '  (none)'}

Analyze this potential leak and provide your expert verdict.`;

    try {
      const raw = await this.callLlm(systemPrompt, userMessage, provider);
      const parsed = this.parseVerdict(raw, bundle);
      return parsed;
    } catch (err: any) {
      this.logger.warn(`[JUDGE] LLM call/parse failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Judge all bundles at once for batch processing.
   */
  async judgeBundles(
    bundles: LeakBundle[],
    staticContext: Map<string, Record<string, any>>,
    analysisMode?: string,
  ): Promise<Map<string, VerdictResult>> {
    const results = new Map<string, VerdictResult>();

    for (const bundle of bundles) {
      const ctx = staticContext.get(bundle.bundleId) || {};
      const verdict = await this.judgeBundle(bundle, ctx, analysisMode);
      results.set(bundle.bundleId, verdict);
    }

    return results;
  }

  /**
   * Pinned judge temperature (default 0). Deterministic verdicts keep the web
   * (JSON-action) path comparable to the TUI path, which pins the same default —
   * a fair paradigm comparison needs both judges sampling identically.
   */
  private judgeTemperature(): number {
    const t = Number(this.config.get('JUDGE_LLM_TEMPERATURE', '0'));
    return Number.isFinite(t) ? t : 0;
  }

  /** Resolve the per-provider API key (kept separate so keys never collide). */
  private judgeApiKey(provider: string): string | undefined {
    if (provider === 'local') return this.config.get<string>('LOCAL_LLM_API_KEY');
    if (provider === 'openai') return this.config.get<string>('OPENAI_API_KEY');
    return this.config.get<string>('ANTHROPIC_API_KEY');
  }

  /**
   * Call the LLM provider.
   *
   * `openai` = the real OpenAI API (OPENAI_* vars), `local` = a local
   * OpenAI-compatible gateway with its OWN vars (LOCAL_LLM_* — separate key,
   * base URL, model). Both speak the OpenAI chat-completions wire format.
   */
  private async callLlm(
    systemPrompt: string,
    userMessage: string,
    provider: string,
  ): Promise<string> {
    if (provider === 'openai') {
      return this.callOpenAiCompatible(systemPrompt, userMessage, {
        apiKey: this.config.get<string>('OPENAI_API_KEY', ''),
        model: this.config.get<string>('OPENAI_MODEL', 'gpt-4o'),
        baseUrl: this.config.get<string>('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
        useJsonFormat: this.config.get<string>('OPENAI_JSON_MODE', 'true') !== 'false',
      });
    }

    if (provider === 'local') {
      return this.callOpenAiCompatible(systemPrompt, userMessage, {
        apiKey: this.config.get<string>('LOCAL_LLM_API_KEY', ''),
        model: this.config.get<string>('LOCAL_LLM_MODEL', 'gh/gpt-5-mini'),
        baseUrl: this.config.get<string>('LOCAL_LLM_BASE_URL', 'http://host.docker.internal:20128/v1'),
        useJsonFormat: this.config.get<string>('LOCAL_LLM_JSON_MODE', 'true') !== 'false',
      });
    }

    // Default: Anthropic
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    const model = this.config.get<string>('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514');

    const response = await this.fetchWithRetry(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey || '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          temperature: this.judgeTemperature(),
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
      },
      { label: 'anthropic' },
    );

    const data: any = await response.json();
    return data.content?.[0]?.text || '';
  }

  /**
   * fetch() with an AbortController timeout + bounded jittered-backoff retry on
   * TRANSIENT failures (timeout/abort, ECONNRESET, "socket closed", HTTP 429/5xx).
   * Non-retryable 4xx and exhausted retries throw — the caller's catch then falls
   * back to the heuristic judge. This is what keeps long LLM scans smooth instead
   * of dropping on the first gateway hiccup.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    opts: { label: string; timeoutMs?: number; retries?: number },
  ): Promise<Response> {
    const timeoutMs = opts.timeoutMs ?? Number(this.config.get('JUDGE_LLM_TIMEOUT_MS', 75000));
    const maxRetries = opts.retries ?? Number(this.config.get('JUDGE_LLM_RETRIES', 2));
    let lastErr: any;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...init, signal: ac.signal });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`${opts.label} HTTP ${res.status}`);
        } else {
          return res; // success or non-retryable 4xx (let caller inspect res.ok)
        }
      } catch (err: any) {
        lastErr = err; // AbortError (timeout), ECONNRESET, socket closed, …
      } finally {
        clearTimeout(timer);
      }
      if (attempt < maxRetries) {
        const backoff = Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
        this.logger.warn(`[JUDGE] ${opts.label} attempt ${attempt + 1} failed (${lastErr?.message}); retry in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr ?? new Error(`${opts.label} request failed`);
  }

  /**
   * Call any OpenAI chat-completions-compatible endpoint (the real OpenAI API
   * or a local gateway). `stream:false` is explicit because some gateways
   * stream (SSE) by default, which would break the single-object JSON parse.
   */
  private async callOpenAiCompatible(
    systemPrompt: string,
    userMessage: string,
    opts: { apiKey: string; model: string; baseUrl: string; useJsonFormat: boolean },
  ): Promise<string> {
    const baseUrl = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const response = await this.fetchWithRetry(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({
          model: opts.model,
          stream: false,
          temperature: this.judgeTemperature(),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          ...(opts.useJsonFormat ? { response_format: { type: 'json_object' } } : {}),
        }),
      },
      { label: 'openai/local' },
    );
    const data: any = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  /**
   * Parse LLM response into a VerdictResult.
   */
  private parseVerdict(raw: string, bundle: LeakBundle): VerdictResult | null {
    const r = parseJsonWith(raw, VerdictSchema);
    if (!r.ok) {
      this.logger.warn(`[JUDGE] verdict rejected for ${bundle.bundleId}: ${r.reason}`);
      return null;
    }
    const parsed = r.value;
    return {
      verdict: parsed.verdict as InvestigationVerdict,
      confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
      explanation: parsed.explanation ?? 'LLM analysis completed',
      evidence: parsed.evidence ? parsed.evidence.map(String) : bundle.evidence.map((e) => `${e.tool}: ${e.function_name}`),
      tool: ToolKind.LLM,
      repair_suggestion: parsed.repair_suggestion,
      rootCause: this.parseRootCause(parsed.rootCause, bundle),
      repairDiff: this.parseRepairDiff(parsed.repairDiff, bundle),
    };
  }

  /** Validate the LLM's structured root-cause object (previously discarded). */
  private parseRootCause(raw: any, bundle: LeakBundle): LeakRootCause | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const validPatterns = Object.values(LeakPatternType) as string[];
    const patternType = validPatterns.includes(raw.patternType)
      ? (raw.patternType as LeakPatternType)
      : LeakPatternType.UNKNOWN;
    const description = typeof raw.description === 'string' ? raw.description : '';
    return {
      patternType,
      description,
      allocationFunction: typeof raw.allocationFunction === 'string' ? raw.allocationFunction : bundle.candidate.function_name,
      allocationLine: Number(raw.allocationLine ?? bundle.candidate.line_number) || 0,
      allocationFile: typeof raw.allocationFile === 'string' ? raw.allocationFile : bundle.candidate.file_path,
      missingFreeLine: raw.missingFreeLine != null ? Number(raw.missingFreeLine) || undefined : undefined,
      missingFreeFunction: typeof raw.missingFreeFunction === 'string' ? raw.missingFreeFunction : undefined,
      rootCauseFunction: typeof raw.rootCauseFunction === 'string' ? raw.rootCauseFunction : bundle.candidate.function_name,
      rootCauseLine: Number(raw.rootCauseLine ?? bundle.candidate.line_number) || 0,
      rootCauseDescription: typeof raw.rootCauseDescription === 'string' ? raw.rootCauseDescription : description,
    };
  }

  /** Validate the LLM's structured before/after repair diff (previously discarded). */
  private parseRepairDiff(raw: any, bundle: LeakBundle): RepairDiff | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const originalLines = Array.isArray(raw.originalLines) ? raw.originalLines.map(String) : [];
    const suggestedLines = Array.isArray(raw.suggestedLines) ? raw.suggestedLines.map(String) : [];
    if (originalLines.length === 0 && suggestedLines.length === 0) return undefined;
    return {
      filePath: typeof raw.filePath === 'string' ? raw.filePath : bundle.candidate.file_path,
      originalLines,
      suggestedLines,
      startLine: Number(raw.startLine ?? bundle.candidate.line_number) || 0,
      description: typeof raw.description === 'string' ? raw.description : '',
    };
  }

  /**
   * Render the static analysis context for the judge prompt. Prefers the rich,
   * typed `bundle.staticEvidence` (ownership summary + alloc→free pairing +
   * feasible leak paths); falls back to the loose context counts.
   */
  private renderStaticContext(bundle: LeakBundle, staticContext?: Record<string, any>): string {
    const se = bundle.staticEvidence;
    if (!se && !staticContext) return '  (no static context available)';
    const lines: string[] = [];

    if (se?.ownership) {
      const own = se.ownership;
      const carrier =
        own.ownershipCarrier?.kind === 'return_value'
          ? 'returned to caller'
          : own.ownershipCarrier?.kind === 'parameter'
            ? `consumed via parameter '${(own.ownershipCarrier as any).name}'`
            : 'none';
      lines.push(`  - Ownership: role=${own.role}; carrier=${carrier} (${own.rationale})`);
    } else {
      lines.push(`  - Ownership type: ${staticContext?.ownership?.ownershipType || 'unknown'}`);
    }

    const pairs = se?.allocFreePairs || [];
    if (pairs.length) {
      lines.push('  - Alloc→free pairing:');
      for (const p of pairs.slice(0, 12)) {
        const freed = p.freeLine != null ? `free@${p.freeLine}` : 'UNPAIRED';
        lines.push(`      ${p.variable}: ${p.allocCall}@${p.allocLine} → ${freed} (${p.status})`);
      }
    } else {
      lines.push(`  - Has explicit free: ${staticContext?.hasExplicitFree} · Allocations: ${(staticContext?.allocations || []).length} · Frees: ${(staticContext?.frees || []).length}`);
    }

    const leakPaths = se?.feasibleLeakPaths || [];
    if (leakPaths.length) {
      lines.push('  - Feasible leak paths:');
      for (const lp of leakPaths.slice(0, 5)) {
        lines.push(`      • ${lp.narrative} (risk: ${lp.leakRisk})`);
      }
    } else {
      lines.push(`  - Feasible paths: ${(staticContext?.feasiblePaths || []).length} · Early returns: ${staticContext?.earlyReturnCount || 0}`);
    }

    return lines.join('\n');
  }

  private readContextSnippet(filePath: string, lineNumber: number): string {
    if (!filePath || !lineNumber || !existsSync(filePath)) return '';
    try {
      // Shared with the TUI judge via @mcpvul/common (comment stripping +
      // enclosing-function extraction). This path prefixes line numbers and uses
      // a symmetric ±5-line fallback window.
      return enclosingFunctionSnippet(readFileSync(filePath, 'utf-8'), lineNumber, {
        withLineNumbers: true,
        fallbackBefore: 5,
        fallbackAfter: 5,
      });
    } catch {
      return '';
    }
  }
}
