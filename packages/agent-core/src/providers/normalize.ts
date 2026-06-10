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
      const msg: Record<string, unknown> = { role: 'assistant', content: text || null };
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
  return {
    text,
    thinking: typeof thinking === 'string' && thinking.trim() ? thinking : undefined,
    toolUses,
    usage: data?.usage
      ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
      : undefined,
    stopReason: mapOpenAiFinish(finish, toolUses.length > 0),
  };
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
      ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 }
      : undefined,
    stopReason: reason,
  };
}

/** Robustly parse a response body that may carry an SSE trailer or stray text. */
export async function readJsonBody(res: Response): Promise<any> {
  const raw = await res.text();
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
