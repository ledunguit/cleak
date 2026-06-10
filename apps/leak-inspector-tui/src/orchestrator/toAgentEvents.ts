/**
 * Translate the agent loop's AgentEvent stream into the scan's ScanEventName
 * vocabulary so the timeline / events.jsonl see agent turns and tool results,
 * and so leakguard / dynamic phases light up when the model first calls one of
 * their tools (and are finished when the investigation ends).
 */

import type { AgentEvent } from '@mcpvul/agent-core';
import { ScanPhase } from '@mcpvul/common/flow/scan-flow-contract';
import { ScanEmitter, ScanEventName } from './events';
import { phaseForMcpTool } from '../domain/mcpToolPlan';

export interface AgentEventBridge {
  handle: (ev: AgentEvent) => void;
  /** Emit *_FINISHED for any optional phase that was started during the loop. */
  finishPendingPhases: () => void;
}

const DYNAMIC_RUN_TOOLS = new Set(['valgrindMemcheck', 'asanRun', 'lsanRun', 'runBinary']);

export function makeAgentEventHandler(emitter: ScanEmitter): AgentEventBridge {
  const started = new Set<ScanPhase>();

  const handle = (ev: AgentEvent): void => {
    switch (ev.type) {
      case 'turn_start':
        emitter.emit(ScanEventName.AGENT_TURN_STARTED, { turn: ev.turn });
        break;
      case 'tool_use': {
        const phase = phaseForMcpTool(ev.name);
        if (phase === ScanPhase.LEAKGUARD && !started.has(phase)) {
          started.add(phase);
          emitter.emit(ScanEventName.LEAKGUARD_STARTED, { tool: ev.name });
        } else if (phase === ScanPhase.DYNAMIC) {
          if (!started.has(phase)) {
            started.add(phase);
            emitter.emit(ScanEventName.DYNAMIC_STARTED, { tool: ev.name });
          }
          if (ev.name === 'buildTarget') emitter.emit(ScanEventName.DYNAMIC_BUILD_STARTED, {});
        }
        break;
      }
      case 'tool_result':
        emitter.emit(ScanEventName.AGENT_TOOL_RESULT, {
          tool: ev.name,
          isError: ev.isError,
          durationMs: ev.durationMs,
        });
        if (!ev.isError && ev.name === 'buildTarget') {
          emitter.emit(ScanEventName.DYNAMIC_BINARY_BUILT, {});
        } else if (DYNAMIC_RUN_TOOLS.has(ev.name)) {
          emitter.emit(ScanEventName.DYNAMIC_TOOL_RESULT, { tool: ev.name, isError: ev.isError });
        }
        break;
      case 'turn_end':
        emitter.emit(ScanEventName.AGENT_TURN_FINISHED, { turn: ev.turn });
        break;
    }
  };

  const finishPendingPhases = (): void => {
    if (started.has(ScanPhase.DYNAMIC)) emitter.emit(ScanEventName.DYNAMIC_FINISHED, {});
    if (started.has(ScanPhase.LEAKGUARD)) emitter.emit(ScanEventName.LEAKGUARD_FINISHED, {});
  };

  return { handle, finishPendingPhases };
}
