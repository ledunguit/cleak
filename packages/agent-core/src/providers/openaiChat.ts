/**
 * OpenAI-compatible chat-completions backend. Serves both the `local` gateway
 * and the real OpenAI API — the only difference is base URL / auth / model.
 * Native function-calling is used; results are normalized to the loop's shape.
 */

import type { CallModelRequest } from '../deps';
import type { NormalizedResponse } from '../types';
import { streamWithRetry } from './transport';
import {
  toOpenAiMessages,
  toOpenAiTools,
  parseOpenAiResponse,
  createOpenAiStreamAssembler,
  coerceJson,
} from './normalize';
import type { ProviderSettings } from './settings';

/** The OpenAI-compatible API rejects response_format:{type:"json_object"} with a 400
 * ("Prompt must contain the word 'json' in some form...") unless the prompt actually
 * mentions it — discovered when this broke the LLM health-check's short, JSON-agnostic
 * probe prompt. Checked instead of assumed so response_format is only ever set when the
 * request can't be rejected for this reason. */
function mentionsJson(req: CallModelRequest): boolean {
  if (/json/i.test(req.systemPrompt)) return true;
  return req.messages.some((m) => typeof m.content === 'string' && /json/i.test(m.content));
}

export async function callOpenAiChat(
  settings: ProviderSettings,
  req: CallModelRequest,
  uuid: () => string,
  onNotice?: (text: string) => void,
): Promise<NormalizedResponse> {
  const baseUrl = settings.baseUrl.replace(/\/+$/, '');
  const body: Record<string, unknown> = {
    model: settings.model,
    max_tokens: settings.maxTokens,
    messages: toOpenAiMessages(req.systemPrompt, req.messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  const temperature = req.temperature ?? settings.temperature;
  if (temperature != null) body.temperature = temperature;
  if (req.tools.length) {
    body.tools = toOpenAiTools(req.tools);
    body.tool_choice = 'auto';
  } else if (settings.jsonMode && mentionsJson(req)) {
    // Tool-less single-shot JSON prompts (judge / strategist / allocator-profiler) already
    // instruct "respond with a JSON object ONLY" — ask the provider to actually enforce
    // that syntactically instead of relying purely on prompt compliance. Gated on an empty
    // tools array so this never interacts with the agentic tool-calling loops, and on
    // mentionsJson so a JSON-agnostic tools:[] call (e.g. the LLM health-check's short
    // probe prompt) doesn't get a response_format the API would 400 on.
    body.response_format = { type: 'json_object' };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  let assembler = createOpenAiStreamAssembler(uuid);
  let fallback: NormalizedResponse | undefined;
  await streamWithRetry(
    `${baseUrl}/chat/completions`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    {
      connectTimeoutMs: settings.connectTimeoutMs,
      idleTimeoutMs: settings.idleTimeoutMs,
      maxTotalMs: settings.timeoutMs,
      retries: settings.retries,
      signal: req.signal,
      onRetry: ({ attempt, reason, nextInMs }) =>
        onNotice?.(`LLM ${reason}; retry ${attempt}/${settings.retries} in ${Math.round(nextInMs / 1000)}s`),
      onAttemptStart: () => {
        assembler = createOpenAiStreamAssembler(uuid);
        fallback = undefined;
      },
      onFirstChunk: req.onFirstChunk,
      onData: (payload) => assembler.push(payload),
      onJsonFallback: (raw) => {
        fallback = parseOpenAiResponse(coerceJson(raw), uuid);
      },
    },
  );
  const result = fallback ?? assembler.finish();
  if (result.stopReason === 'max_tokens') {
    onNotice?.(`LLM response truncated at token budget (maxTokens=${settings.maxTokens}) — output may be incomplete`);
  }
  return result;
}
