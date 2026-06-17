/**
 * Prompts + terminal tools for the workflow's sub-agents. Each sub-agent has a
 * SMALL, focused context (only its candidate partition) and a restricted toolset:
 *   - static sub-agent: read-only static tools, gathers evidence, no verdicts.
 *   - dynamic worker: build + sanitizers, attaches runtime evidence.
 * Verdicts are produced later by the hybrid judge — not by these sub-agents.
 */

import { z } from 'zod';
import { buildTool, type Tool } from '@mcpvul/agent-core';
import type { LeakBundle } from '@mcpvul/common/types';

export const DONE_STATIC = 'done_static';
export const DONE_DYNAMIC = 'done_dynamic';

/** A no-op terminal tool that ends a sub-agent loop (registered in `terminalTools`). */
export function buildDoneTool(name: string, description: string): Tool {
  return buildTool({
    name,
    description,
    inputSchema: z.object({ note: z.string().optional() }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: async (input: { note?: string }) => ({ done: true, note: input?.note ?? '' }),
  });
}

function candidateList(bundles: LeakBundle[]): string {
  return bundles
    .map(
      (b) =>
        `- ${b.bundleId} — ${b.candidate.function_name || '?'}() at ${b.candidate.file_path}:${b.candidate.line_number} (${b.candidate.allocation_type || 'alloc'})`,
    )
    .join('\n');
}

// ── Static sub-agent ──

export function staticSubAgentSystemPrompt(repoPath: string): string {
  return [
    `You are a STATIC-ANALYSIS evidence-gathering sub-agent for C/C++ memory leaks.`,
    `You do NOT record verdicts — your only job is to RUN the static tools so the system can collect structured evidence for each candidate, then call \`${DONE_STATIC}\`.`,
    ``,
    `For EACH candidate in your list, gather evidence:`,
    `- \`functionSummary\` (filePath, functionName) — alloc/free balance + leaky exit paths.`,
    `- \`pathConstraints\` (filePath, lineNumber of the allocation) — feasible leaking paths.`,
    `- \`astScan\` (filePath) — structural patterns + early returns.`,
    `- \`ownershipConventions\` (filePath) — ownership-transfer / missing-free conventions.`,
    `- \`read_file\` to inspect the source and, for interprocedural cases (a function returning an allocation), follow the caller.`,
    ``,
    `Efficiency: you MAY call several of these read-only tools in a SINGLE turn — they run in parallel. The repository root is ${repoPath}.`,
    `When you have run the static tools for EVERY candidate in your list, call \`${DONE_STATIC}\`. Do NOT reply with prose — only tool calls advance the work.`,
  ].join('\n');
}

export function staticSubAgentUserMessage(bundles: LeakBundle[]): string {
  return [
    `Gather static evidence for these ${bundles.length} candidate allocation site(s):`,
    candidateList(bundles),
    ``,
    `Run the static tools for each, then call ${DONE_STATIC}.`,
  ].join('\n');
}

// ── Dynamic worker ──

export function dynamicWorkerSystemPrompt(repoPath: string, buildCommand?: string): string {
  return [
    `You are a DYNAMIC-ANALYSIS sub-agent for C/C++ memory leaks. Build the project ONCE with a sanitizer, run it under a sanitizer, then call \`${DONE_DYNAMIC}\`.`,
    ``,
    `1. \`read_file\` the Makefile / CMakeLists.txt / build script under ${repoPath} to learn how it builds.${buildCommand ? ` A hint build command was provided: \`${buildCommand}\`.` : ''}`,
    `2. \`buildTarget\` (projectPath=${repoPath}, buildCommand = a clang command with sanitizer flags). Prefer LeakSanitizer (\`-fsanitize=leak -g -O0\`) — it reports at exit and never aborts mid-run.`,
    `3. Run the binary with \`lsanRun\` (or \`asanRun\` / \`valgrindMemcheck\`).`,
    ``,
    `The system CAPTURES every finding from your sanitizer runs AUTOMATICALLY and attaches it to the matching candidate — you do NOT record evidence yourself. Your only job is to get a successful sanitizer run.`,
    `Build at most ONCE and run each dynamic tool at most once. If a build or sanitizer fails twice, stop and call \`${DONE_DYNAMIC}\`. When a sanitizer has run, call \`${DONE_DYNAMIC}\`. Do NOT reply with prose.`,
  ].join('\n');
}

export function dynamicWorkerUserMessage(bundles: LeakBundle[]): string {
  return [
    `Run a sanitizer once over the build that covers these ${bundles.length} candidate(s):`,
    candidateList(bundles.slice(0, 100)),
    bundles.length > 100 ? `… and ${bundles.length - 100} more.` : '',
    ``,
    `Build once, run a sanitizer (the system captures the findings), then call ${DONE_DYNAMIC}.`,
  ]
    .filter(Boolean)
    .join('\n');
}
