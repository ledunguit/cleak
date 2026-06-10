/**
 * Translate the loop's content-block message model to/from the two provider
 * wire formats: OpenAI-compatible chat completions (covers the `local` gateway
 * and real OpenAI) and the Anthropic Messages API. Keeping this isolated means
 * the loop and tools never learn a provider's quirks.
 */

import type { Message, ContentBlock, ToolUseBlock, NormalizedResponse, StopReason } from '../types';
import type { Tool } from '../tool';
import { toolParametersJSONSchema } from './schema';

// ── Tool definitions ──

export function toOpenAiTools(tools: Tool[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: toolParametersJSONSchema(t),
    },
  }));
}

export function toAnthropicTools(tools: Tool[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: toolParametersJSONSchema(t),
  }));
}

// ── Outbound message conversion ──

function blocks(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

/** Our messages → OpenAI chat messages (assistant tool_calls, separate `tool` role results). */
export function toOpenAiMessages(systemPrompt: string, messages: Message[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: systemPrompt }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const bs = blocks(m.content);
      const text = bs.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const toolCalls = bs
        .filter((b): b is ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      // An assistant message must carry content OR tool_calls — a null/empty content
      // with no tool_calls is rejected by OpenAI-compatible gateways ("assistant must
      // provide content, reasoning_content or tool_calls"). When there are tool_calls,
      // null content is fine; otherwise fall back to a non-empty placeholder.
      const msg: Record<string, unknown> = {
        role: 'assistant',
        content: text || (toolCalls.length ? null : '(no content)'),
      };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      // user message: split tool_result blocks into individual `tool` messages.
      const bs = blocks(m.content);
      const toolResults = bs.filter((b) => b.type === 'tool_result');
      if (toolResults.length) {
        for (const b of toolResults) {
          const tr = b as { tool_use_id: string; content: string };
          out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content });
        }
        const text = bs.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
        if (text) out.push({ role: 'user', content: text });
      } else {
        const text = bs.map((b) => (b.type === 'text' ? b.text : '')).join('');
        out.push({ role: 'user', content: text });
      }
    }
  }
  return out;
}

/** Our messages → Anthropic messages (content blocks map almost 1:1). */
export function toAnthropicMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    const bs = blocks(m.content);
    const content = bs.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      return { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error };
    });
    return { role: m.role, content };
  });
}

// ── Inbound response parsing ──

/** Recover JSON arguments from a possibly-malformed string (small models drift). */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        /* give up */
      }
    }
    return {};
  }
}

function mapOpenAiFinish(reason: string | undefined, hasTools: boolean): StopReason {
  if (hasTools || reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'stop';
}

export function parseOpenAiResponse(data: any, uuid: () => string): NormalizedResponse {
  const choice = data?.choices?.[0]?.message;
  const finish = data?.choices?.[0]?.finish_reason;
  const text: string = choice?.content ?? '';
  const toolUses: ToolUseBlock[] = Array.isArray(choice?.tool_calls)
    ? choice.tool_calls.map((tc: any) => ({
        type: 'tool_use' as const,
        id: tc.id || uuid(),
        name: tc.function?.name,
        input: parseToolArguments(tc.function?.arguments),
      }))
    : [];
  const thinking: string | undefined = choice?.reasoning_content || choice?.reasoning || undefined;
  const thinkingText = typeof thinking === 'string' && thinking.trim() ? thinking : undefined;
  return {
    text,
    thinking: thinkingText,
    toolUses,
    usage: data?.usage
      ? {
          inputTokens: data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.completion_tokens ?? 0,
          thinkingTokens: openAiReasoningTokens(data.usage, thinkingText),
        }
      : undefined,
    stopReason: mapOpenAiFinish(finish, toolUses.length > 0),
  };
}

/** Reasoning-token count: prefer the provider's number, else estimate from text. */
function openAiReasoningTokens(usage: any, thinkingText?: string): number {
  const reported = usage?.completion_tokens_details?.reasoning_tokens;
  if (typeof reported === 'number' && reported > 0) return reported;
  return thinkingText ? Math.ceil(thinkingText.length / 4) : 0;
}

/** ~4 chars/token estimate, for providers that don't report reasoning tokens. */
function estimateTokensFromText(text: string): number {
  return text.trim() ? Math.ceil(text.length / 4) : 0;
}

export function parseAnthropicResponse(data: any, uuid: () => string): NormalizedResponse {
  const content: any[] = Array.isArray(data?.content) ? data.content : [];
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const thinking = content.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('') || undefined;
  const toolUses: ToolUseBlock[] = content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ type: 'tool_use' as const, id: b.id || uuid(), name: b.name, input: b.input ?? {} }));
  const reason: StopReason =
    data?.stop_reason === 'max_tokens' ? 'max_tokens' : toolUses.length > 0 ? 'tool_use' : 'stop';
  return {
    text,
    thinking: thinking || undefined,
    toolUses,
    usage: data?.usage
      ? {
          inputTokens: data.usage.input_tokens ?? 0,
          outputTokens: data.usage.output_tokens ?? 0,
          // Anthropic folds thinking into output_tokens — estimate for visibility.
          thinkingTokens: thinking ? estimateTokensFromText(thinking) : 0,
        }
      : undefined,
    stopReason: reason,
  };
}

/** Robustly parse a JSON body that may carry an SSE trailer or stray text. */
export function coerceJson(raw: string): any {
  // Strip a trailing SSE chunk after the JSON object (e.g. "\ndata: [DONE]").
  let body = raw;
  const end = raw.lastIndexOf('}');
  if (end > 0 && end < raw.length - 1) {
    const trailer = raw.slice(end + 1).trim();
    if (trailer.startsWith('data:') || trailer.startsWith(':')) body = raw.slice(0, end + 1);
  }
  try {
    return JSON.parse(body);
  } catch {
    const match = body.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        /* fall through */
      }
    }
    throw new Error(`Provider returned non-JSON response: ${raw.slice(0, 200)}`);
  }
}

/** Robustly parse a response body that may carry an SSE trailer or stray text. */
export async function readJsonBody(res: Response): Promise<any> {
  return coerceJson(await res.text());
}

// ── Streaming assemblers ──
// Each provider streams a sequence of SSE `data:` payloads; the assembler folds
// the deltas into the same NormalizedResponse the non-streaming path returns, so
// the loop never learns whether a turn was streamed.

export interface StreamAssembler {
  /** Fold one SSE `data:` payload (raw JSON string) into the running response. */
  push(payload: string): void;
  /** Final NormalizedResponse once the stream ends. */
  finish(): NormalizedResponse;
}

/** OpenAI-compatible chat-completions streaming (covers the local gateway + OpenAI). */
export function createOpenAiStreamAssembler(uuid: () => string): StreamAssembler {
  let text = '';
  let thinking = '';
  let finish: string | undefined;
  let usage: NormalizedResponse['usage'];
  const calls = new Map<number, { id?: string; name?: string; args: string }>();

  return {
    push(payload) {
      let obj: any;
      try {
        obj = JSON.parse(payload);
      } catch {
        return;
      }
      const choice = obj?.choices?.[0];
      const delta = choice?.delta;
      if (delta) {
        if (typeof delta.content === 'string') text += delta.content;
        const r = delta.reasoning_content ?? delta.reasoning;
        if (typeof r === 'string') thinking += r;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            const cur = calls.get(idx) ?? { args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments;
            calls.set(idx, cur);
          }
        }
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (obj?.usage) {
        usage = {
          inputTokens: obj.usage.prompt_tokens ?? 0,
          outputTokens: obj.usage.completion_tokens ?? 0,
          thinkingTokens: openAiReasoningTokens(obj.usage, thinking.trim() ? thinking : undefined),
        };
      }
    },
    finish() {
      const toolUses: ToolUseBlock[] = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => ({
          type: 'tool_use' as const,
          id: c.id || uuid(),
          name: c.name ?? '',
          input: parseToolArguments(c.args),
        }));
      return {
        text,
        thinking: thinking.trim() ? thinking : undefined,
        toolUses,
        usage,
        stopReason: mapOpenAiFinish(finish, toolUses.length > 0),
      };
    },
  };
}

/** Anthropic Messages API streaming (SSE events carry their `type` inside the JSON). */
export function createAnthropicStreamAssembler(uuid: () => string): StreamAssembler {
  let text = '';
  let thinking = '';
  let stopReason: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  const blocks = new Map<number, { type?: string; id?: string; name?: string; json: string }>();

  return {
    push(payload) {
      let e: any;
      try {
        e = JSON.parse(payload);
      } catch {
        return;
      }
      switch (e?.type) {
        case 'message_start':
          inputTokens = e.message?.usage?.input_tokens ?? 0;
          break;
        case 'content_block_start': {
          const cb = e.content_block ?? {};
          blocks.set(e.index, { type: cb.type, id: cb.id, name: cb.name, json: '' });
          if (cb.type === 'text' && typeof cb.text === 'string') text += cb.text;
          break;
        }
        case 'content_block_delta': {
          const d = e.delta ?? {};
          if (d.type === 'text_delta') text += d.text ?? '';
          else if (d.type === 'thinking_delta') thinking += d.thinking ?? '';
          else if (d.type === 'input_json_delta') {
            const b = blocks.get(e.index);
            if (b) b.json += d.partial_json ?? '';
          }
          break;
        }
        case 'message_delta':
          if (e.delta?.stop_reason) stopReason = e.delta.stop_reason;
          if (e.usage?.output_tokens != null) outputTokens = e.usage.output_tokens;
          break;
        default:
          break;
      }
    },
    finish() {
      const toolUses: ToolUseBlock[] = [...blocks.entries()]
        .filter(([, b]) => b.type === 'tool_use')
        .sort((a, b) => a[0] - b[0])
        .map(([, b]) => ({
          type: 'tool_use' as const,
          id: b.id || uuid(),
          name: b.name ?? '',
          input: parseToolArguments(b.json || '{}'),
        }));
      const reason: StopReason =
        stopReason === 'max_tokens' ? 'max_tokens' : toolUses.length > 0 ? 'tool_use' : 'stop';
      return {
        text,
        thinking: thinking.trim() ? thinking : undefined,
        toolUses,
        usage: { inputTokens, outputTokens, thinkingTokens: estimateTokensFromText(thinking) },
        stopReason: reason,
      };
    },
  };
}
