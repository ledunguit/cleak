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
  return fallback ?? assembler.finish();
}
