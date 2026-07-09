/**
 * The agentic turn loop. An async generator that, each turn:
 *   1. asks the model for the next step (text + tool_use blocks),
 *   2. appends the assistant message,
 *   3. resolves permissions for each requested tool (may pause for the user),
 *   4. dispatches tools — read-only & concurrency-safe ones in parallel (capped),
 *      everything else serially,
 *   5. threads the tool_result blocks back as one user message,
 * and repeats until the model stops, a terminal tool fires, the turn budget is
 * spent, or the run is aborted. Every step is `yield`ed as an AgentEvent so a
 * headless sink or a TUI can render it.
 */

import type { AgentEvent, ContentBlock, LoopResult, Message, ToolResultBlock, ToolUseBlock, Usage } from './types';
import { findToolByName, truncateResult, type Tool, type ToolCtx } from './tool';
import type { AgentDeps } from './deps';
import { estimateTokens, pruneStaleToolResults } from './compaction';
import { mapWithLimit } from './concurrency';

export interface QueryParams {
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
  ctx: ToolCtx;
  maxTurns: number;
  deps: AgentDeps;
  /** Tool names that end the loop with reason 'finalized' once they run successfully. */
  terminalTools?: Set<string>;
  /** Max read-only tools to execute concurrently in one batch. */
  concurrency?: number;
  /** Drained at each turn start — lets the user steer the agent mid-run by injecting user messages. */
  getSteering?: () => string[];
  /**
   * Called when the model call fails (after its own retries). Returns 'resume'
   * to retry the turn (the user typed "continue"/guidance) or 'abort' to stop.
   * When absent (headless), a model failure ends the run with reason 'error'.
   */
  awaitResume?: (reason: string) => Promise<'resume' | 'abort'>;
  /**
   * Auto-compaction: once the (estimated) prompt size crosses `thresholdTokens`,
   * stale tool-result payloads outside the most recent `keepRecentTurns` turns are
   * pruned in place before the next model call. Omit to disable.
   */
  compaction?: { thresholdTokens: number; keepRecentTurns: number };
  /**
   * Side-channel UI cue for model I/O: `'send'` fires just before the request,
   * `'receive'` fires on the first streamed chunk. Not a yielded event because
   * the first chunk arrives mid-await (a yield would land after the whole turn).
   */
  onModelActivity?: (dir: 'send' | 'receive') => void;
  /**
   * Completion guard. Called when the model returns no tool calls (i.e. it would
   * stop). Return a nudge string to inject as a user message and keep going (the
   * work isn't actually done — e.g. candidates still lack verdicts), or `null` to
   * allow the run to stop. Bounded by `maxStopNudges` so a stubborn model can't
   * loop forever; the counter resets whenever a turn makes progress (calls tools).
   */
  checkCompletion?: () => string | null;
  /** Max consecutive nudges before a bare stop is honored (default 3). */
  maxStopNudges?: number;
}

interface ExecResult {
  output: unknown;
  isError: boolean;
  durationMs: number;
  block: ToolResultBlock;
}

export async function* queryLoop(params: QueryParams): AsyncGenerator<AgentEvent, LoopResult> {
  const { systemPrompt, tools, ctx, maxTurns, deps } = params;
  const concurrency = params.concurrency ?? 10;
  const terminalTools = params.terminalTools ?? new Set<string>();
  const messages: Message[] = [...params.messages];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let turn = 0;
  let lastInputTokens = 0; // prompt size the model reported last turn (drives compaction)
  const maxStopNudges = params.maxStopNudges ?? 3;
  let stopNudges = 0; // consecutive "stopped early" nudges; reset when a turn calls tools

  while (true) {
    if (ctx.abortSignal?.aborted) {
      yield { type: 'done', reason: 'aborted' };
      return { messages, reason: 'aborted', turns: turn, usage };
    }

    turn++;
    yield { type: 'turn_start', turn };

    // 0. Inject any user steering messages queued since the last turn.
    const steering = params.getSteering?.() ?? [];
    for (const text of steering) {
      if (text.trim()) messages.push({ role: 'user', content: text });
    }

    // 0b. Compact the transcript if it has grown past the threshold. Use the
    // model-reported prompt size when available, else a cheap char estimate.
    if (params.compaction) {
      const approxTokens = lastInputTokens || estimateTokens(messages);
      if (approxTokens > params.compaction.thresholdTokens) {
        const saved = pruneStaleToolResults(messages, params.compaction.keepRecentTurns);
        if (saved > 0) {
          yield { type: 'notice', text: `Compacted context: pruned ~${Math.round(saved / 4)} tokens of stale tool output` };
        }
      }
    }

    // 1. Ask the model.
    let resp;
    try {
      params.onModelActivity?.('send');
      resp = await deps.callModel({
        systemPrompt,
        messages,
        tools,
        signal: ctx.abortSignal,
        onFirstChunk: () => params.onModelActivity?.('receive'),
      });
    } catch (err: unknown) {
      if (ctx.abortSignal?.aborted) {
        yield { type: 'done', reason: 'aborted' };
        return { messages, reason: 'aborted', turns: turn, usage };
      }
      const message = err instanceof Error ? err.message : String(err);
      // Pause and wait for the user (e.g. "continue" or new guidance) instead of
      // ending the run. The retried turn reuses this turn number (no budget burn).
      if (params.awaitResume) {
        yield { type: 'paused', reason: message };
        const decision = await params.awaitResume(message);
        if (decision === 'abort' || ctx.abortSignal?.aborted) {
          yield { type: 'done', reason: 'aborted' };
          return { messages, reason: 'aborted', turns: turn, usage };
        }
        yield { type: 'resumed' };
        turn--;
        continue;
      }
      yield { type: 'error', message };
      yield { type: 'done', reason: 'error', message };
      return { messages, reason: 'error', turns: turn, usage };
    }
    if (resp.usage) {
      usage.inputTokens += resp.usage.inputTokens;
      usage.outputTokens += resp.usage.outputTokens;
      usage.thinkingTokens = (usage.thinkingTokens ?? 0) + (resp.usage.thinkingTokens ?? 0);
      if (resp.usage.inputTokens > 0) lastInputTokens = resp.usage.inputTokens;
    }
    if (resp.thinking) yield { type: 'thinking', text: resp.thinking };

    // 2. Append the assistant message (text + tool_use blocks).
    const assistantContent: ContentBlock[] = [];
    if (resp.text) assistantContent.push({ type: 'text', text: resp.text });
    for (const tu of resp.toolUses) assistantContent.push(tu);
    if (assistantContent.length > 0) {
      messages.push({ role: 'assistant', content: assistantContent });
    } else {
      // The model produced only reasoning/thinking (no text, no tool calls). Never
      // append an EMPTY assistant message — OpenAI-compatible providers reject
      // "assistant must provide content, reasoning_content or tool_calls". Carry the
      // thinking text (or a minimal placeholder) so the turn stays valid.
      messages.push({ role: 'assistant', content: resp.thinking?.trim() || '(thinking)' });
    }
    if (resp.text) yield { type: 'assistant_text', text: resp.text };

    // No tools requested → the model wants to stop. Before honoring that, give the
    // caller a chance to say the work isn't done (e.g. candidates still un-judged)
    // and nudge the model to finish — bounded by maxStopNudges so it can't loop.
    if (resp.toolUses.length === 0) {
      const nudge =
        turn < maxTurns && stopNudges < maxStopNudges ? params.checkCompletion?.() ?? null : null;
      if (nudge) {
        stopNudges++;
        messages.push({ role: 'user', content: nudge });
        yield { type: 'notice', text: `Agent stopped early — nudging to finish (${stopNudges}/${maxStopNudges})` };
        yield { type: 'turn_end', turn, usage: resp.usage };
        continue;
      }
      yield { type: 'turn_end', turn, usage: resp.usage };
      yield { type: 'done', reason: 'stop' };
      return { messages, reason: 'stop', turns: turn, usage };
    }
    stopNudges = 0; // the model is making progress (calling tools) → reset the nudge budget

    // Announce each requested tool call.
    for (const tu of resp.toolUses) {
      const tool = findToolByName(tools, tu.name);
      yield {
        type: 'tool_use',
        id: tu.id,
        name: tu.name,
        input: tu.input,
        isReadOnly: tool ? tool.isReadOnly(tu.input) : false,
      };
    }

    // 3. Resolve permissions (sequential — may pause for interactive approval).
    const decisions = new Map<string, 'allow' | 'deny'>();
    for (const tu of resp.toolUses) {
      const tool = findToolByName(tools, tu.name);
      if (!tool) {
        decisions.set(tu.id, 'allow'); // executes → reports "unknown tool" error
        continue;
      }
      const perm = await tool.checkPermissions(tu.input, ctx);
      if (perm.behavior === 'deny') {
        decisions.set(tu.id, 'deny');
        yield { type: 'permission_decision', id: tu.id, name: tu.name, decision: 'deny' };
        continue;
      }
      if (perm.behavior === 'ask') {
        yield { type: 'permission_request', id: tu.id, name: tu.name, input: tu.input };
        const decision = ctx.requestPermission
          ? await ctx.requestPermission({ id: tu.id, name: tu.name, input: tu.input })
          : 'allow';
        decisions.set(tu.id, decision);
        yield { type: 'permission_decision', id: tu.id, name: tu.name, decision };
        continue;
      }
      decisions.set(tu.id, 'allow');
    }

    // 4. Dispatch — partition allowed calls into a concurrent batch + a serial tail.
    const execOne = async (tu: ToolUseBlock): Promise<ExecResult> => {
      const start = deps.now();
      if (decisions.get(tu.id) === 'deny') {
        return errResult(tu.id, 'Permission denied by user.', deps.now() - start);
      }
      const tool = findToolByName(tools, tu.name);
      if (!tool) return errResult(tu.id, `Unknown tool: ${tu.name}`, deps.now() - start);
      try {
        const output = await tool.call(tu.input, ctx);
        const base = tool.mapResultToBlock(output, tu.id) as ToolResultBlock;
        const block: ToolResultBlock = { ...base, content: truncateResult(base.content, tool.maxResultSizeChars) };
        return { output, isError: false, durationMs: deps.now() - start, block };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errResult(tu.id, msg, deps.now() - start);
      }
    };

    const isConcurrent = (tu: ToolUseBlock): boolean => {
      if (decisions.get(tu.id) === 'deny') return false;
      const tool = findToolByName(tools, tu.name);
      return !!tool && tool.isReadOnly(tu.input) && tool.isConcurrencySafe(tu.input);
    };

    const concurrentCalls = resp.toolUses.filter(isConcurrent);
    const serialCalls = resp.toolUses.filter((tu) => !isConcurrent(tu));

    const execMap = new Map<string, ExecResult>();
    const concurrentResults = await mapWithLimit(concurrentCalls, concurrency, execOne);
    concurrentCalls.forEach((tu, i) => execMap.set(tu.id, concurrentResults[i]));
    for (const tu of serialCalls) {
      execMap.set(tu.id, await execOne(tu));
    }

    // 5. Emit results in request order and thread them back as one user message.
    const resultBlocks: ContentBlock[] = [];
    for (const tu of resp.toolUses) {
      const r = execMap.get(tu.id)!;
      yield { type: 'tool_result', id: tu.id, name: tu.name, output: r.output, isError: r.isError, durationMs: r.durationMs };
      resultBlocks.push(r.block);
    }
    messages.push({ role: 'user', content: resultBlocks });

    // Terminal tool ran successfully → finalize.
    const finalized = resp.toolUses.some(
      (tu) => terminalTools.has(tu.name) && execMap.get(tu.id) && !execMap.get(tu.id)!.isError,
    );
    yield { type: 'turn_end', turn, usage: resp.usage };
    if (finalized) {
      yield { type: 'done', reason: 'finalized' };
      return { messages, reason: 'finalized', turns: turn, usage };
    }
    if (turn >= maxTurns) {
      yield { type: 'done', reason: 'max_turns' };
      return { messages, reason: 'max_turns', turns: turn, usage };
    }
  }
}

function errResult(toolUseId: string, message: string, durationMs: number): ExecResult {
  return {
    output: message,
    isError: true,
    durationMs,
    block: { type: 'tool_result', tool_use_id: toolUseId, content: message, is_error: true },
  };
}
