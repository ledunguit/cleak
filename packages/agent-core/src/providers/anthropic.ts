/**
 * Anthropic Messages API backend. Content-block messages map almost 1:1, so
 * this is a thin request builder + response normalizer.
 */

import type { CallModelRequest } from '../deps';
import type { NormalizedResponse } from '../types';
import { streamWithRetry } from './transport';
import {
  toAnthropicMessages,
  toAnthropicTools,
  parseAnthropicResponse,
  createAnthropicStreamAssembler,
  coerceJson,
} from './normalize';
import type { ProviderSettings } from './settings';

export async function callAnthropic(
  settings: ProviderSettings,
  req: CallModelRequest,
  uuid: () => string,
  onNotice?: (text: string) => void,
): Promise<NormalizedResponse> {
  if (!settings.apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const baseUrl = settings.baseUrl.replace(/\/+$/, '');
  const body: Record<string, unknown> = {
    model: settings.model,
    max_tokens: settings.maxTokens,
    system: req.systemPrompt,
    messages: toAnthropicMessages(req.messages),
    stream: true,
  };
  if (req.tools.length) body.tools = toAnthropicTools(req.tools);

  let assembler = createAnthropicStreamAssembler(uuid);
  let fallback: NormalizedResponse | undefined;
  await streamWithRetry(
    `${baseUrl}/v1/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    },
    {
      connectTimeoutMs: settings.connectTimeoutMs,
      idleTimeoutMs: settings.idleTimeoutMs,
      retries: settings.retries,
      signal: req.signal,
      onRetry: ({ attempt, reason, nextInMs }) =>
        onNotice?.(`LLM ${reason}; retry ${attempt}/${settings.retries} in ${Math.round(nextInMs / 1000)}s`),
      onAttemptStart: () => {
        assembler = createAnthropicStreamAssembler(uuid);
        fallback = undefined;
      },
      onFirstChunk: req.onFirstChunk,
      onData: (payload) => assembler.push(payload),
      onJsonFallback: (raw) => {
        fallback = parseAnthropicResponse(coerceJson(raw), uuid);
      },
    },
  );
  return fallback ?? assembler.finish();
}
