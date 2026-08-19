/**
 * Provider dispatcher: turn ProviderSettings into a `CallModel` the loop can
 * call. `local` and `openai` share the chat-completions path; `anthropic` uses
 * the Messages API.
 */

import type { CallModel } from '../deps';
import { callOpenAiChat } from './openaiChat';
import { callAnthropic } from './anthropic';
import type { ProviderSettings } from './settings';

export * from './settings';
export { fetchWithRetry } from './transport';
export {
  toOpenAiMessages,
  toAnthropicMessages,
  toOpenAiTools,
  toAnthropicTools,
  parseToolArguments,
} from './normalize';
export { toolParametersJSONSchema } from './schema';

export function buildCallModel(
  settings: ProviderSettings,
  uuid: () => string = () => globalThis.crypto.randomUUID(),
  onNotice?: (text: string) => void,
  /** Fired once per call whose response came back truncated at the token budget
   * (`stopReason === 'max_tokens'`) — a distinct signal from `onNotice`'s
   * human-readable text, for callers that want a live count (e.g. per-case
   * sweep-health stats) without parsing notice strings. */
  onTruncation?: () => void,
): CallModel {
  return async (req) => {
    const resp =
      settings.provider === 'anthropic'
        ? await callAnthropic(settings, req, uuid, onNotice)
        : await callOpenAiChat(settings, req, uuid, onNotice);
    if (resp.stopReason === 'max_tokens') onTruncation?.();
    return resp;
  };
}
