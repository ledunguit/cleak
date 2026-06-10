/**
 * OpenAI-compatible chat-completions backend. Serves both the `local` gateway
 * and the real OpenAI API — the only difference is base URL / auth / model.
 * Native function-calling is used; results are normalized to the loop's shape.
 */

import type { CallModelRequest } from '../deps';
import type { NormalizedResponse } from '../types';
import { fetchWithRetry } from './transport';
import { toOpenAiMessages, toOpenAiTools, parseOpenAiResponse, readJsonBody } from './normalize';
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
  };
  if (req.tools.length) {
    body.tools = toOpenAiTools(req.tools);
    body.tool_choice = 'auto';
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  const res = await fetchWithRetry(
    `${baseUrl}/chat/completions`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    {
      timeoutMs: settings.timeoutMs,
      retries: settings.retries,
      signal: req.signal,
      onRetry: ({ attempt, reason, nextInMs }) =>
        onNotice?.(`LLM ${reason}; retry ${attempt}/${settings.retries} in ${Math.round(nextInMs / 1000)}s`),
    },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`LLM error ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await readJsonBody(res);
  return parseOpenAiResponse(data, uuid);
}
