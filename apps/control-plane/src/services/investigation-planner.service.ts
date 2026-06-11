import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BuildPlan,
  InvestigationNextAction,
  InvestigationPlan,
  LeakBundle,
  ToolExecutionRecord,
  AgentDecision,
  AgentActionKind,
  AgentLoopState,
  InvestigationVerdict,
  LeakPatternType,
  ToolCost,
} from '@mcpvul/common';
import { CreateScanDto } from '@mcpvul/common/dto/scan.dto';

/** A next-action decision produced by the orchestrator brain, tagged with its source. */
export type AgentDecisionDraft = {
  actionKind: string;
  toolName?: string;
  targetBundleIds: string[];
  rationale: string;
  reasoning: string;
  args?: Record<string, unknown>;
  strategySource: 'heuristic' | 'llm';
};

@Injectable()
export class InvestigationPlannerService {
  private readonly logger = new Logger(InvestigationPlannerService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Build the system prompt for the orchestrator LLM agent.
   * This is the core "brain" of the agentic scanner.
   */
  buildOrchestratorSystemPrompt(toolCatalog: ToolCost[]): string {
    const toolDescriptions = toolCatalog
      .map(
        (t) =>
          `- ${t.name}: ${t.description} (${t.typicalDurationMs}ms, phase: ${t.phase}, ` +
          `prerequisites: [${t.prerequisites.join(', ') || 'none'}], ` +
          `provides: [${t.providesEvidenceFor.join(', ') || 'general'}])`,
      )
      .join('\n');

    return `You are the Orchestrator Agent for a C/C++ memory leak detection system.

YOUR ROLE:
You are the "brain" that controls a suite of analysis tools. Your mission is to find
as many real memory leaks as possible in the given C/C++ codebase. You decide what
tools to run, in what order, on which candidates, and when to stop investigating.

AVAILABLE TOOLS:
${toolDescriptions}

ANALYSIS STRATEGY GUIDE:
1. DISCOVERY PHASE: Start with indexing and candidate scanning. This gives you a list
   of all allocation sites (malloc, calloc, realloc, strdup, new) in the codebase.
2. CANDIDATE RANKING: Not all allocations are leaks. Prioritize candidates where:
   - The allocation is inside a function body (not a global)
   - The function has multiple exit paths (conditional returns)
   - The allocation is inside a loop
   - The function has no matching free()
   - The returned pointer is not stored or passed to a deallocator
3. INVESTIGATION LOOP: For each high-priority candidate, systematically:
   a) Run AST scan for structural analysis
   b) Run function summary to check alloc/free balance
   c) If conditional branches exist, run path constraints
   d) If the function calls others, run call graph + interprocedural flow
   e) If still uncertain, consider LeakGuard or dynamic analysis
4. EFFICIENCY: Don't run heavy tools on every candidate. Be strategic:
   - Light tools first (candidate_scan, function_summary)
   - Medium tools next (ast_scan, path_constraints, call_graph)
   - Heavy tools last (interprocedural_flow, leakguard, dynamic)
5. STOP CONDITION: When you have enough evidence for each candidate to make
   a confident verdict (CONFIRMED, LIKELY, UNCERTAIN), finish.

CHAIN OF THOUGHT:
Before each decision, reason step by step:
1. What is the current state? (How many bundles? What evidence exists?)
2. What's the most suspicious bundle right now?
3. What information am I missing to make a verdict on it?
4. Which tool can provide that information most efficiently?
5. What's my plan: tool X on bundles [a, b, c] because ___

OUTPUT FORMAT:
You must respond with a JSON object ONLY. No other text.
{
  "actionKind": "run_static_tool | run_leakguard | run_dynamic | judge_bundle | request_more_evidence | deep_investigate | change_strategy | finish",
  "rationale": "Short reason for this decision",
  "toolName": "tool name if action involves a specific tool",
  "targetBundleIds": ["bundle_xxx", "bundle_yyy"],
  "reasoning": "Your step-by-step chain of thought",
  "args": { /* optional tool-specific arguments */ }
}`;
  }

  /**
   * Build the context for the LLM describing the current state.
   */
  buildStateContext(
    state: AgentLoopState,
    bundles: LeakBundle[],
    toolCatalog: ToolCost[],
    dynamicMode?: string,
  ): string {
    const totalBundles = bundles.length;
    const verdictCounts: Record<string, number> = {};
    for (const b of bundles) {
      const v = b.verdict?.verdict || 'pending';
      verdictCounts[v] = (verdictCounts[v] || 0) + 1;
    }

    const topBundles = bundles
      .sort((a, b) => {
        const aScore = a.verdict?.confidence || 0;
        const bScore = b.verdict?.confidence || 0;
        return bScore - aScore;
      })
      .slice(0, 15)
      .map(
        (b) =>
          `- [${b.bundleId}] ${b.candidate.function_name} @ ${b.candidate.file_path}:${b.candidate.line_number} ` +
          `(alloc: ${b.candidate.allocation_type}, confidence: ${b.candidate.confidence}, ` +
          `verdict: ${b.verdict?.verdict || 'pending'}, evidence: ${b.evidence.length} items)`,
      )
      .join('\n');

    const toolHistory = state.actionsTaken
      .slice(-10)
      .map((a) => `  [Turn ${a.turn}] ${a.actionKind} -> ${a.resultSummary || 'pending'}`)
      .join('\n');

    return `SCAN STATE:
- Phase: ${state.phase}
- Total bundles: ${totalBundles}
- Verdicts: ${JSON.stringify(verdictCounts)}
- Turn: ${state.actionsTaken.length}
- Investigation loops: ${state.investigationCount}/${state.maxInvestigationLoops}
- Strategy: ${state.currentStrategy}
- Dynamic analysis: ${dynamicMode && dynamicMode !== 'off' ? `enabled (${dynamicMode}) — run_dynamic is permitted` : 'disabled — do NOT choose run_dynamic'}

TOP CANDIDATES:
${topBundles}

RECENT ACTIONS:
${toolHistory || '  (none yet)'}

AVAILABLE TOOLS (${toolCatalog.length} total):
${toolCatalog.map((t) => `  - ${t.name}: ${t.description}`).join('\n')}`;
  }

  /**
   * Build the LLM prompt for re-planning mid-scan.
   */
  buildReplanPrompt(
    state: AgentLoopState,
    bundles: LeakBundle[],
    buildPlan: BuildPlan | null,
  ): string {
    const unresolvedBundles = bundles.filter(
      (b) => !b.verdict || b.verdict.verdict === InvestigationVerdict.UNCERTAIN,
    );
    const highPriorityBundles = unresolvedBundles.filter(
      (b) => b.candidate.confidence === 'high' || b.candidate.confidence === 'medium',
    );

    return `CURRENT STATE: Investigation phase, ${state.investigationCount} loops completed.
UNRESOLVED BUNDLES: ${unresolvedBundles.length} total, ${highPriorityBundles.length} high/medium priority.
BUILD PLAN AVAILABLE: ${buildPlan?.buildCommand ? 'yes (' + buildPlan.buildSystem + ')' : 'no'}
DYNAMIC ANALYSIS POSSIBLE: ${buildPlan?.binaryCandidates?.length ? 'yes' : 'no (no binary found yet)'}

I need to decide whether to:
1. Continue investigating unresolved bundles with more static tools
2. Try LeakGuard for deeper static analysis
3. Build and run dynamic analysis (ASan/LSan/Valgrind) if binary available
4. Judge the remaining bundles and finish
5. Change strategy

The top unresolved bundles that need attention:
${highPriorityBundles.slice(0, 10).map((b) =>
  `  - ${b.bundleId}: ${b.candidate.function_name} @ ${b.candidate.file_path}:${b.candidate.line_number} (evidence: ${b.evidence.length} items)`).join('\n')}

What is the best next action? Respond with JSON only.`;
  }

  /**
   * Main planning method - delegates to LLM or heuristic.
   */
  async plan(args: {
    dto: CreateScanDto;
    buildPlan: BuildPlan | null;
    bundles: LeakBundle[];
    toolCatalog: ToolCost[];
  }): Promise<InvestigationPlan> {
    if (args.dto.analysisMode === 'llm_assisted') {
      try {
        const llmPlan = await this.planWithLlm(args);
        if (llmPlan) return llmPlan;
      } catch (err: any) {
        this.logger.warn(`LLM investigation planning failed, falling back to heuristic: ${err.message}`);
      }
    }

    return this.planHeuristically(args);
  }

  /**
   * Main decision method for the agentic loop.
   * Returns what action the orchestrator should take next.
   */
  async decideNextAction(args: {
    state: AgentLoopState;
    bundles: LeakBundle[];
    buildPlan: BuildPlan | null;
    toolCatalog: ToolCost[];
    analysisMode?: string;
    dynamicMode?: string;
  }): Promise<AgentDecisionDraft> {
    // Only consult the LLM in llm_assisted mode; no_llm stays purely heuristic
    // so the two modes can be compared cleanly and strategySource is truthful.
    if (args.analysisMode === 'llm_assisted' && args.bundles.length > 0) {
      try {
        const llmDecision = await this.decideWithLlm(args);
        if (llmDecision) return llmDecision;
      } catch (err: any) {
        this.logger.warn(`LLM decision failed, using heuristic: ${err.message}`);
      }
    }

    // Heuristic fallback (and the only decision path in no_llm mode)
    return { ...this.decideHeuristically(args), strategySource: 'heuristic' };
  }

  /**
   * LLM-powered decision making.
   */
  private async decideWithLlm(args: {
    state: AgentLoopState;
    bundles: LeakBundle[];
    buildPlan: BuildPlan | null;
    toolCatalog: ToolCost[];
    dynamicMode?: string;
  }): Promise<AgentDecisionDraft | null> {
    const provider = this.config.get<string>('ORCHESTRATOR_LLM_PROVIDER', this.config.get<string>('LLM_PROVIDER', 'anthropic'));
    const systemPrompt = this.buildOrchestratorSystemPrompt(args.toolCatalog);
    const stateContext = this.buildStateContext(args.state, args.bundles, args.toolCatalog, args.dynamicMode);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: stateContext },
    ];

    try {
      let raw: string;
      if (provider === 'openai') {
        raw = await this.callOpenAI(systemPrompt, stateContext);
      } else if (provider === 'local') {
        raw = await this.callLocal(systemPrompt, stateContext);
      } else {
        raw = await this.callAnthropic(systemPrompt, stateContext);
      }

      const parsed = this.parseDecision(raw, args.bundles);
      if (parsed) return { ...parsed, strategySource: 'llm' };

      this.logger.warn('LLM returned unparseable decision, using heuristic');
    } catch (err: any) {
      this.logger.warn(`LLM call failed: ${err.message}`);
    }

    return null;
  }

  /**
   * Heuristic fallback decision logic.
   */
  private decideHeuristically(args: {
    state: AgentLoopState;
    bundles: LeakBundle[];
    buildPlan: BuildPlan | null;
    toolCatalog: ToolCost[];
    dynamicMode?: string;
  }): { actionKind: string; toolName?: string; targetBundleIds: string[]; rationale: string; reasoning: string; args?: Record<string, unknown> } {
    const pending = args.bundles.filter((b) => !b.verdict);
    const uncertain = args.bundles.filter(
      (b) => b.verdict?.verdict === InvestigationVerdict.UNCERTAIN,
    );
    const highPriority = [...pending, ...uncertain].filter(
      (b) => b.candidate.confidence === 'high' || b.candidate.confidence === 'medium',
    );
    const allUnresolved = [...pending, ...uncertain];

    // Phase 1: If we haven't started investigating, pick top bundles
    if (args.state.phase === 'candidate_ranking' || (pending.length === args.bundles.length && args.state.actionsTaken.length < 3)) {
      const topBundles = [...args.bundles]
        .sort((a, b) => {
          const order: Record<string, number> = { high: 3, medium: 2, low: 1 };
          return (order[b.candidate.confidence] || 0) - (order[a.candidate.confidence] || 0);
        })
        .slice(0, Math.min(10, args.bundles.length))
        .map((b) => b.bundleId);

      return {
        actionKind: 'run_static_tool',
        toolName: 'memory.ast_scan',
        targetBundleIds: topBundles,
        rationale: `Starting investigation on ${topBundles.length} highest-confidence bundles`,
        reasoning: 'Phase transition: ranking complete, beginning investigation of top candidates with AST scan.',
      };
    }

    // Phase 2: Investigate high-priority unresolved bundles with static tools
    if (highPriority.length > 0 && args.state.investigationCount < args.state.maxInvestigationLoops) {
      const targetBundles = highPriority.slice(0, Math.min(5, highPriority.length));
      const targetIds = targetBundles.map((b) => b.bundleId);

      // Choose the best next tool based on what's already been run
      const executedTools = new Set(args.state.actionsTaken.map((a) => a.toolName).filter(Boolean));
      const toolOrder = [
        { name: 'memory.function_summary', phase: 'static_analysis' },
        { name: 'memory.ast_scan', phase: 'static_analysis' },
        { name: 'memory.call_graph', phase: 'static_analysis' },
        { name: 'memory.path_constraints', phase: 'static_analysis' },
        { name: 'memory.interprocedural_flow', phase: 'static_analysis' },
        { name: 'memory.ownership_summary', phase: 'static_analysis' },
      ];

      for (const tool of toolOrder) {
        if (!executedTools.has(tool.name) && args.toolCatalog.some((t) => t.name === tool.name)) {
          return {
            actionKind: 'run_static_tool',
            toolName: tool.name,
            targetBundleIds: targetIds,
            rationale: `Running ${tool.name} on ${targetIds.length} high-priority bundles`,
            reasoning: `Investigation loop ${args.state.investigationCount + 1}/${args.state.maxInvestigationLoops}. Target: ${targetIds.length} bundles with high/medium confidence that need deeper analysis.`,
          };
        }
      }

      // All basic tools exhausted, try deeper analysis
      if (args.buildPlan?.buildCommand) {
        return {
          actionKind: 'run_leakguard',
          targetBundleIds: targetIds,
          rationale: `Static tools exhausted, running LeakGuard on key candidates`,
          reasoning: 'Deep static analysis needed after basic tools are done.',
        };
      }
    }

    // Phase 3: Try dynamic analysis if enabled and a binary is available
    const dynamicEnabled = Boolean(args.dynamicMode && args.dynamicMode !== 'off');
    if (dynamicEnabled && args.buildPlan?.binaryCandidates?.length && args.buildPlan?.buildCommand) {
      return {
        actionKind: 'run_dynamic',
        toolName: 'asan.run',
        targetBundleIds: allUnresolved.map((b) => b.bundleId),
        rationale: `Static analysis complete, proceeding with dynamic confirmation (${args.dynamicMode})`,
        reasoning: 'Binary available and dynamic mode enabled; dynamic analysis will confirm or refute static findings.',
      };
    }

    // Phase 4: Judge remaining and finish
    return {
      actionKind: 'judge_bundle',
      targetBundleIds: allUnresolved.map((b) => b.bundleId),
      rationale: 'All investigation options exhausted, producing final verdicts',
      reasoning: 'No more tools can provide additional evidence. Finalizing verdicts.',
    };
  }

  async replan(args: {
    dto: CreateScanDto;
    buildPlan: BuildPlan | null;
    bundles: LeakBundle[];
    toolCatalog: ToolCost[];
    currentPlan: InvestigationPlan;
    executionRecords: ToolExecutionRecord[];
    stage: string;
  }): Promise<InvestigationPlan> {
    return this.normalizePlan(this.planHeuristically(args), args);
  }

  private planHeuristically(args: {
    dto: CreateScanDto;
    buildPlan: BuildPlan | null;
    bundles: LeakBundle[];
  }): InvestigationPlan {
    const sorted = [...args.bundles].sort((a, b) =>
      confidenceRank(b.candidate.confidence) - confidenceRank(a.candidate.confidence),
    );
    const dynamicTool = args.dto.dynamicToolPreference || 'auto';
    const focusBundleIds = sorted.slice(0, Math.min(sorted.length, 40)).map((bundle) => bundle.bundleId);

    return {
      strategySource: 'heuristic',
      focusBundleIds,
      staticToolSequence: [
        'memory.ast_scan',
        'memory.call_graph',
        'memory.function_summary',
        'memory.path_constraints',
        'memory.interprocedural_flow',
        'memory.ownership_summary',
      ],
      runLeakguard: Boolean(args.buildPlan?.buildCommand || args.dto.buildCommand),
      runDynamic: Boolean(args.dto.dynamicMode && args.dto.dynamicMode !== 'off'),
      dynamicToolPreference: dynamicTool,
      bundleLimit: focusBundleIds.length,
      rationale: `Prioritize ${focusBundleIds.length} highest-confidence bundles, run broad static evidence first, then use ${dynamicTool} for dynamic confirmation when a binary is available.`,
      notes: [
        args.buildPlan ? `Build system detected: ${args.buildPlan.buildSystem}` : 'No build plan available; static analysis remains primary.',
        args.dto.dynamicMode && args.dto.dynamicMode !== 'off'
          ? `Dynamic mode enabled with preference ${dynamicTool}.`
          : 'Dynamic analysis disabled; rely on static + LeakGuard evidence.',
      ],
    };
  }

  private async planWithLlm(args: {
    dto: CreateScanDto;
    buildPlan: BuildPlan | null;
    bundles: LeakBundle[];
    toolCatalog: ToolCost[];
  }): Promise<InvestigationPlan | null> {
    const provider = this.config.get<string>('LLM_PROVIDER', 'anthropic');
    const prompt = this.buildPlannerPrompt(args);
    const raw = provider === 'openai'
      ? await this.callOpenAI(prompt, '')
      : provider === 'local'
        ? await this.callLocal(prompt, '')
        : await this.callAnthropic(prompt, '');

    const parsed = this.parsePlan(raw, args.bundles);
    return parsed;
  }

  /**
   * Pinned planner temperature (default 0). Recorded in eval provenance; pinning
   * it makes the orchestrator's tool-selection reproducible across runs.
   */
  private plannerTemperature(): number {
    const t = Number(this.config.get('PLANNER_LLM_TEMPERATURE', '0'));
    return Number.isFinite(t) ? t : 0;
  }

  private async callAnthropic(systemPrompt: string, userMessage: string): Promise<string> {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    const model = this.config.get<string>('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: this.plannerTemperature(),
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    const data: any = await response.json();
    return data.content?.[0]?.text || '';
  }

  private async callOpenAI(systemPrompt: string, userMessage: string): Promise<string> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    const model = this.config.get<string>('OPENAI_MODEL', 'gpt-4o');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: this.plannerTemperature(),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    const data: any = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  private async callLocal(systemPrompt: string, userMessage: string): Promise<string> {
    const baseUrl = this.config.get<string>('LOCAL_LLM_URL', 'http://localhost:11434/api/chat');
    const model = this.config.get<string>('LOCAL_LLM_MODEL', 'llama3');

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: this.plannerTemperature(),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        stream: false,
      }),
    });

    const data: any = await response.json();
    return data.message?.content || '';
  }

  private parseDecision(
    raw: string,
    bundles: LeakBundle[],
  ): { actionKind: string; toolName?: string; targetBundleIds: string[]; rationale: string; reasoning: string; args?: Record<string, unknown> } | null {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const validKinds = ['run_static_tool', 'run_leakguard', 'run_dynamic', 'judge_bundle', 'request_more_evidence', 'deep_investigate', 'change_strategy', 'finish'];
      if (!validKinds.includes(parsed.actionKind)) return null;

      const bundleIds = new Set(bundles.map((b) => b.bundleId));
      const targetBundleIds = Array.isArray(parsed.targetBundleIds)
        ? parsed.targetBundleIds.filter((id: string) => bundleIds.has(id))
        : [];

      return {
        actionKind: parsed.actionKind,
        toolName: typeof parsed.toolName === 'string' ? parsed.toolName : undefined,
        targetBundleIds,
        rationale: typeof parsed.rationale === 'string' ? parsed.rationale : 'LLM-selected action',
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
        args: typeof parsed.args === 'object' && parsed.args ? parsed.args : undefined,
      };
    } catch {
      return null;
    }
  }

  private parsePlan(raw: string, bundles: LeakBundle[]): InvestigationPlan | null {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const bundleIds = new Set(bundles.map((b) => b.bundleId));
      const focusBundleIds = Array.isArray(parsed.focusBundleIds)
        ? parsed.focusBundleIds.filter((id: string) => bundleIds.has(id))
        : bundles.slice(0, 40).map((b) => b.bundleId);

      return {
        strategySource: 'llm',
        focusBundleIds,
        staticToolSequence: Array.isArray(parsed.staticToolSequence) ? parsed.staticToolSequence : [],
        runLeakguard: Boolean(parsed.runLeakguard),
        runDynamic: Boolean(parsed.runDynamic),
        dynamicToolPreference: typeof parsed.dynamicToolPreference === 'string' ? parsed.dynamicToolPreference : 'auto',
        bundleLimit: typeof parsed.bundleLimit === 'number' ? parsed.bundleLimit : focusBundleIds.length,
        rationale: typeof parsed.rationale === 'string' ? parsed.rationale : 'LLM-selected scan strategy',
        notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : [],
      };
    } catch {
      return null;
    }
  }

  private buildPlannerPrompt(args: {
    dto: CreateScanDto;
    buildPlan: BuildPlan | null;
    bundles: LeakBundle[];
  }): string {
    const topBundles = args.bundles
      .slice(0, 20)
      .map(
        (b) =>
          `[${b.bundleId}] ${b.candidate.function_name} in ${b.candidate.file_path}:${b.candidate.line_number} ` +
          `(allocation: ${b.candidate.allocation_type}, confidence: ${b.candidate.confidence})`,
      )
      .join('\n');

    return `You are planning a memory leak investigation for a C/C++ codebase.

Found ${args.bundles.length} allocation candidates.
Build system: ${args.buildPlan?.buildSystem || 'unknown'}
Build command: ${args.buildPlan?.buildCommand || 'not available'}
Dynamic mode: ${args.dto.dynamicMode || 'off'}

Top candidates:
${topBundles}

Design an investigation plan that specifies:
1. focusBundleIds: which bundles to prioritize (up to 40)
2. staticToolSequence: order of static analysis tools
3. runLeakguard: whether to use LeakGuard
4. runDynamic: whether to use dynamic analysis
5. rationale: explanation of strategy

Respond with JSON only.`;
  }

  private normalizePlan(
    plan: InvestigationPlan,
    args: {
      toolCatalog: ToolCost[];
      executionRecords: ToolExecutionRecord[];
    },
  ): InvestigationPlan {
    const validTools = new Set(args.toolCatalog.map((tool) => tool.name));
    const executedTools = new Set(
      args.executionRecords.filter((record) => record.status === 'success').map((record) => record.toolName),
    );

    return {
      ...plan,
      staticToolSequence: plan.staticToolSequence.filter((tool) => validTools.has(tool) && !executedTools.has(tool)),
    };
  }
}

function confidenceRank(confidence: string): number {
  if (confidence === 'high') return 3;
  if (confidence === 'medium') return 2;
  return 1;
}
