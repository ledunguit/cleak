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

    // 1. Ask the model.
    let resp;
    try {
      resp = await deps.callModel({ systemPrompt, messages, tools, signal: ctx.abortSignal });
    } catch (err: any) {
      if (ctx.abortSignal?.aborted) {
        yield { type: 'done', reason: 'aborted' };
        return { messages, reason: 'aborted', turns: turn, usage };
      }
      const message = err?.message ?? String(err);
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
    }
    if (resp.thinking) yield { type: 'thinking', text: resp.thinking };

    // 2. Append the assistant message (text + tool_use blocks).
    const assistantContent: ContentBlock[] = [];
    if (resp.text) assistantContent.push({ type: 'text', text: resp.text });
    for (const tu of resp.toolUses) assistantContent.push(tu);
    messages.push({ role: 'assistant', content: assistantContent.length ? assistantContent : resp.text ?? '' });
    if (resp.text) yield { type: 'assistant_text', text: resp.text };

    // No tools requested → the model is done talking.
    if (resp.toolUses.length === 0) {
      yield { type: 'turn_end', turn, usage: resp.usage };
      yield { type: 'done', reason: 'stop' };
      return { messages, reason: 'stop', turns: turn, usage };
    }

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
      } catch (err: any) {
        return errResult(tu.id, err?.message ?? String(err), deps.now() - start);
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

/** Run `fn` over `items` with at most `limit` in flight; preserves input order in the result. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker);
  await Promise.all(workers);
  return results;
}
