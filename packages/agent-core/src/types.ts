/**
 * Core message + event types for the agentic loop. Deliberately small — a
 * trimmed echo of message model
 * just enough to drive a native tool-calling conversation against any provider.
 */

export type Role = 'user' | 'assistant';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  /** Always a string (JSON-stringified for structured output) — matches what all providers expect. */
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: Role;
  content: string | ContentBlock[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Reasoning/thinking tokens, when the provider reports them (OpenAI
   * `completion_tokens_details.reasoning_tokens`) or as an estimate from the
   * streamed thinking text. Informational — for most providers these are a
   * SUBSET of `outputTokens`, so a total is still `inputTokens + outputTokens`.
   */
  thinkingTokens?: number;
}

export type StopReason = 'stop' | 'tool_use' | 'max_tokens' | 'error';

/** What `callModel` returns, normalized across providers. */
export interface NormalizedResponse {
  text: string;
  /** Provider reasoning / thinking content, when exposed (e.g. mimo reasoning_content). */
  thinking?: string;
  toolUses: ToolUseBlock[];
  usage?: Usage;
  stopReason: StopReason;
}

export type DoneReason = 'stop' | 'max_turns' | 'finalized' | 'aborted' | 'error';

/**
 * The observability/UI stream yielded by `queryLoop`. Each event is a render
 * cue (headless: written to events.jsonl; TUI: pushed into the store).
 */
export type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'notice'; text: string }
  | { type: 'paused'; reason: string }
  | { type: 'resumed' }
  | { type: 'thinking'; text: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown; isReadOnly: boolean }
  | { type: 'tool_result'; id: string; name: string; output: unknown; isError: boolean; durationMs: number }
  | { type: 'permission_request'; id: string; name: string; input: unknown }
  | { type: 'permission_decision'; id: string; name: string; decision: 'allow' | 'deny' }
  | { type: 'turn_end'; turn: number; usage?: Usage }
  | { type: 'done'; reason: DoneReason; message?: string }
  | { type: 'error'; message: string };

export interface LoopResult {
  messages: Message[];
  reason: DoneReason;
  turns: number;
  usage: Usage;
}
