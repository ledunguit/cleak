/**
 * Anthropic Messages API backend. Content-block messages map almost 1:1, so
 * this is a thin request builder + response normalizer.
 */

import type { CallModelRequest } from '../deps';
import type { NormalizedResponse } from '../types';
import { fetchWithRetry } from './transport';
import { toAnthropicMessages, toAnthropicTools, parseAnthropicResponse, readJsonBody } from './normalize';
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
  };
  if (req.tools.length) body.tools = toAnthropicTools(req.tools);

  const res = await fetchWithRetry(
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
      timeoutMs: settings.timeoutMs,
      retries: settings.retries,
      signal: req.signal,
      onRetry: ({ attempt, reason, nextInMs }) =>
        onNotice?.(`LLM ${reason}; retry ${attempt}/${settings.retries} in ${Math.round(nextInMs / 1000)}s`),
    },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Anthropic error ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await readJsonBody(res);
  return parseAnthropicResponse(data, uuid);
}
