/**
 * Records the (post-path-mapping, analyzer-side) input of the harness worker's LAST
 * successful `buildHarness` call, so the orchestrator's deterministic fuzz-escalation
 * step (Stage B2, no extra LLM turn) can recompile the SAME harness source with
 * `entryStyle: 'fuzzer'` without re-deriving anything the LLM already decided
 * (linkage strategy, closure files, argument values).
 *
 * Wrap as the INNERMOST layer — `withDynamicEvidenceCapture(withHostPathMapping(
 * withHarnessInputCapture(rawTool, capture), resolver), store, opts)` — so the
 * captured `input` is already analyzer-side (host→analyzer path mapping applied),
 * directly reusable by the raw (unwrapped) tool for the escalation call.
 */

import type { Tool } from '@cleak/agent-core';
import { coerceToObject } from './mcpResult';

export interface HarnessBuildInputCapture {
  input?: {
    projectPath: string;
    buildCommand: string;
    harnessSource: string;
    targetFile: string;
    closureFiles?: string[];
  };
  binaryPath?: string;
  success?: boolean;
}

export function withHarnessInputCapture(tool: Tool, capture: HarnessBuildInputCapture): Tool {
  if (tool.name !== 'buildHarness') return tool;
  return {
    ...tool,
    call: async (input: any, ctx: any) => {
      const out = await tool.call(input, ctx);
      try {
        const o = coerceToObject<{ success?: boolean; binaryPath?: string }>(out);
        if (o.success !== false) {
          capture.input = {
            projectPath: input.projectPath,
            buildCommand: input.buildCommand,
            harnessSource: input.harnessSource,
            targetFile: input.targetFile,
            closureFiles: input.closureFiles,
          };
          capture.binaryPath = o.binaryPath;
        }
        capture.success = o.success !== false;
      } catch {
        /* capture is best-effort — never break the tool call */
      }
      return out;
    },
  };
}
