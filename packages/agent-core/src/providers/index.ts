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
): CallModel {
  return async (req) => {
    if (settings.provider === 'anthropic') return callAnthropic(settings, req, uuid, onNotice);
    return callOpenAiChat(settings, req, uuid, onNotice);
  };
}
