/**
 * Dependency-injection seam for the loop. Tests inject a fake `callModel`;
 * production wires the real provider dispatcher. Keeping the model call behind
 * this interface makes the loop deterministic and testable without a network.
 */

import type { NormalizedResponse, Message } from './types';
import type { Tool } from './tool';

export interface CallModelRequest {
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
  signal?: AbortSignal;
  /** Fired once when the first streamed chunk arrives (drives a "receiving" UI cue). */
  onFirstChunk?: () => void;
}

export type CallModel = (req: CallModelRequest) => Promise<NormalizedResponse>;

export interface AgentDeps {
  callModel: CallModel;
  uuid: () => string;
  now: () => number;
  log: (msg: string) => void;
}

export function productionDeps(callModel: CallModel): AgentDeps {
  return {
    callModel,
    uuid: () => globalThis.crypto.randomUUID(),
    now: () => Date.now(),
    log: () => undefined,
  };
}
