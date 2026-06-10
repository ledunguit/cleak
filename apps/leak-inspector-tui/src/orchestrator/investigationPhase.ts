/**
 * The agentic investigation phase — the heart of the "agentic" scan. It assembles
 * the analysis toolset (static MCP tools + optional dynamic + domain tools),
 * builds the leak-investigation system prompt, seeds the conversation with the
 * discovered candidates, and runs the native tool-calling loop. The model freely
 * chooses which analysis tools to run on which candidate and records a verdict
 * per candidate; the loop ends when it calls finalize_report (or hits the turn
 * budget). Verdicts land on the shared CandidateManager; the controller then
 * heuristically finalizes anything left and renders the report.
 */

import {
  buildCallModel,
  loadMcpTools,
  productionDeps,
  queryLoop,
  type AgentEvent,
  type Message,
  type ProviderSettings,
  type Tool,
  type ToolCtx,
} from '@mcpvul/agent-core';
import { isAbsolute, resolve } from 'node:path';
import { AgentActionKind, DynamicMode, type AgentDecision } from '@mcpvul/common/types';
import type { RunConfig } from '../config';
import type { InvestigationContext, InvestigationOutcome, InvestigationPhase } from './investigation';
import { mcpToolFlags, CONTENT_CAPABLE_TOOLS } from '../domain/mcpToolPlan';
import { readFileSafe } from '../domain/fileWalk';
import { buildDomainTools, FINALIZE_TOOL } from '../domain/domainTools';
import { buildInvestigationSystemPrompt, buildInitialUserMessage } from '../domain/systemPrompt';
import { ScanEventName } from './events';
import { makeAgentEventHandler } from './toAgentEvents';
import { StepLog } from '../domain/stepLog';

export function buildInvestigationPhase(cfg: RunConfig, dynamicMode: DynamicMode): InvestigationPhase {
  return {
    async run(candidates, ctx: InvestigationContext): Promise<InvestigationOutcome> {
      const stepLog = new StepLog();
      // Non-fatal notices (LLM timeout/retry) surface to the UI + step log so a
      // slow gateway looks like "retrying…", not a frozen app.
      const onNotice = (text: string) => {
        const ev: AgentEvent = { type: 'notice', text };
        ctx.onAgentEvent?.(ev);
        stepLog.record(ev);
      };
      const callModel = buildCallModel(toProviderSettings(cfg), () => globalThis.crypto.randomUUID(), onNotice);

      // Assemble the toolset. The workspace lives on the host, so we expose only
      // the analyzer tools that accept file CONTENT (the rest need a shared
      // filesystem) and inject each file's content host-side before the call.
      // The agent therefore works entirely in host paths; the analyzer is a
      // stateless content-based service (local or remote, same code path).
      const inject = (t: Tool) => withHostContent(t, ctx.repoPath);
      const staticTools = (await loadMcpTools(ctx.staticClient, mcpToolFlags))
        .filter((t) => CONTENT_CAPABLE_TOOLS.has(t.name))
        .map(inject);
      // Dynamic tools build/run code on the analyzer, so they need real filesystem
      // paths translated host→analyzer (e.g. /Users/.../demo → /workspace/demo).
      let dynamicTools: Tool[] = [];
      if (dynamicMode !== DynamicMode.OFF && ctx.dynamicClient) {
        dynamicTools = (await loadMcpTools(ctx.dynamicClient, mcpToolFlags)).map((t) =>
          withHostPathMapping(t, ctx.pathResolver),
        );
      }

      const decisions: AgentDecision[] = [];
      const domainTools = buildDomainTools({
        candidates,
        repoPath: ctx.repoPath,
        pathResolver: ctx.pathResolver,
        onVerdict: (bundleId, verdict, args) => {
          decisions.push({
            turn: decisions.length + 1,
            actionKind: AgentActionKind.JUDGE_BUNDLE,
            rationale: (verdict.explanation || '').slice(0, 200),
            strategySource: 'llm',
            toolName: 'record_verdict',
            targetBundleIds: [bundleId],
            args,
            reasoning: '',
            decidedAt: new Date().toISOString(),
            resultSummary: `${verdict.verdict} (${(verdict.confidence * 100).toFixed(0)}%)`,
          });
        },
      });

      const tools = [...staticTools, ...dynamicTools, ...domainTools];
      const systemPrompt = buildInvestigationSystemPrompt({
        repoPath: ctx.repoPath,
        toolNames: tools.map((t) => t.name),
        dynamicEnabled: dynamicMode !== DynamicMode.OFF,
        buildCommand: ctx.buildCommand,
      });
      const messages: Message[] = [{ role: 'user', content: buildInitialUserMessage(candidates.getAllBundles()) }];

      // Dynamic analysis spends turns building/running, so give it more headroom.
      const maxTurns = dynamicMode !== DynamicMode.OFF ? cfg.maxTurns + 15 : cfg.maxTurns;

      ctx.emitter.emit(ScanEventName.INVESTIGATION_STARTED, {
        candidates: candidates.getAllBundles().length,
        tools: tools.length,
        maxTurns,
      });

      const bridge = makeAgentEventHandler(ctx.emitter);
      const toolCtx: ToolCtx = {
        cwd: ctx.repoPath,
        requestPermission: ctx.requestPermission,
        abortSignal: ctx.abortSignal,
      };

      const gen = queryLoop({
        systemPrompt,
        messages,
        tools,
        ctx: toolCtx,
        maxTurns,
        deps: productionDeps(callModel),
        terminalTools: new Set([FINALIZE_TOOL]),
        getSteering: ctx.getSteering,
        awaitResume: ctx.awaitResume,
      });

      let result: { messages: Message[]; reason: string; turns: number; usage: { inputTokens: number; outputTokens: number } } | undefined;
      while (true) {
        const next = await gen.next();
        if (next.done) {
          result = next.value;
          break;
        }
        const ev = next.value as AgentEvent;
        bridge.handle(ev);
        ctx.onAgentEvent?.(ev);
        stepLog.record(ev);
      }
      bridge.finishPendingPhases();

      ctx.emitter.emit(ScanEventName.INVESTIGATION_FINISHED, {
        turns: result!.turns,
        reason: result!.reason,
        verdicts: decisions.length,
      });

      return {
        reason: result!.reason,
        turns: result!.turns,
        agentDecisions: decisions,
        transcript: result!.messages,
        usage: result!.usage,
        stepsLog: stepLog.toMarkdown(),
      };
    },
  };
}

/**
 * Inject the host file's content into an MCP tool call. The agent passes a
 * `filePath` (host path, absolute or repo-relative); we read it on the host and
 * add `content`, so the stateless analyzer never needs filesystem access. The
 * filePath is normalized to an absolute host path for the read.
 */
function withHostContent(tool: Tool, repoPath: string): Tool {
  return {
    ...tool,
    call: (input: any, ctx) => {
      const next = input && typeof input === 'object' ? { ...input } : input;
      if (next && typeof next === 'object' && typeof next.filePath === 'string') {
        const abs = isAbsolute(next.filePath) ? next.filePath : resolve(repoPath, next.filePath);
        if (!next.content) {
          const content = readFileSafe(abs);
          if (content !== null) next.content = content;
        }
        next.filePath = abs;
      }
      return tool.call(next, ctx);
    },
  };
}

/**
 * Translate filesystem path arguments (host → analyzer) for dynamic tools, which
 * build/compile/run code on the analyzer's filesystem. Identity when no mapping
 * is configured (the analyzer shares the host filesystem).
 */
function withHostPathMapping(
  tool: Tool,
  resolver: { hasMapping(): boolean; toAnalyzerPath(p: string): string },
): Tool {
  if (!resolver.hasMapping()) return tool;
  const PATH_KEYS = ['projectPath', 'binaryPath', 'cwd', 'workdir'];
  return {
    ...tool,
    call: (input: any, ctx) => {
      const next = input && typeof input === 'object' ? { ...input } : input;
      if (next && typeof next === 'object') {
        for (const k of PATH_KEYS) if (typeof next[k] === 'string') next[k] = resolver.toAnalyzerPath(next[k]);
      }
      return tool.call(next, ctx);
    },
  };
}

function toProviderSettings(cfg: RunConfig): ProviderSettings {
  return {
    provider: cfg.llm.provider,
    baseUrl: cfg.llm.baseUrl,
    apiKey: cfg.llm.apiKey,
    model: cfg.llm.model,
    maxTokens: cfg.llm.maxTokens,
    timeoutMs: cfg.llm.timeoutMs,
    retries: cfg.llm.retries,
  };
}
