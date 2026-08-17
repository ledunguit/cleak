/**
 * Prompts + terminal tools for the workflow's sub-agents. Each sub-agent has a
 * SMALL, focused context (only its candidate partition) and a restricted toolset:
 *   - static sub-agent: read-only static tools, gathers evidence, no verdicts.
 *   - dynamic worker: build + sanitizers, attaches runtime evidence.
 * Verdicts are produced later by the hybrid judge — not by these sub-agents.
 */

import { z } from 'zod';
import { buildTool, type Tool } from '@cleak/agent-core';
import type { LeakBundle } from '@cleak/common/types';

export const DONE_STATIC = 'done_static';
export const DONE_DYNAMIC = 'done_dynamic';
export const DONE_HARNESS = 'done_harness';

/** A no-op terminal tool that ends a sub-agent loop (registered in `terminalTools`). */
export function buildDoneTool(name: string, description: string): Tool<{ note?: string }, { done: boolean; note: string }> {
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

// staticSubAgentSystemPrompt deliberately does NOT tell the model to skip remaining
// tools once a candidate already looks "clearly" resolved — it always runs all 4
// static tools per candidate. This was flagged as a plausible token-saving
// opportunity during an efficiency audit, then deliberately left as-is: this
// codebase's own measured evaluation data (docs/EVALUATION.md §3b) shows the
// DETERMINISTIC-recipe baseline (B6a) beats the agentic tool-selecting baselines
// (B6b/B7) on F1 (0.938 vs 0.929) at ~9x LOWER token cost (463k vs ~4.2M) — i.e.
// giving the model more autonomy over its own tool-calling procedure has already
// been shown, in this exact system, to trade accuracy for savings that don't
// materialize. Don't "fix" this without re-running that comparison.
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

// ── Harness worker (Stage B2 — targeted dynamic verification) ──

/**
 * ONE worker per candidate: static evidence alone was borderline and the cheap
 * whole-binary Stage B run didn't already confirm it, so write a small driver that
 * calls JUST the suspicious function and get a sanitizer to run it directly instead
 * of hoping the whole program's default execution happens to reach it.
 */
export function harnessWorkerSystemPrompt(repoPath: string, buildCommand: string, analyzerProjectPath: string): string {
  return [
    `You are a TARGETED-HARNESS sub-agent for ONE C/C++ memory-leak candidate. Static analysis alone was inconclusive for it, and the project's normal execution didn't exercise it either — your job is to write a SMALL driver that calls just the suspicious function, compile it, and run it under a sanitizer.`,
    `You do NOT record verdicts — you only get a sanitizer to run against the right code. The system captures findings from your sanitizer run automatically.`,
    ``,
    `The repository root is ${repoPath}. Its build command is: \`${buildCommand}\`.`,
    ``,
    `Linkage — pick ONE based on the "static linkage" fact given below:`,
    `- If the target function is NOT static (external linkage): your harness source should \`extern\`-declare it (matching the given return type + parameter types) and call it with concrete argument values. Pass the file(s) needed to link it (usually just the target's own file) as \`closureFiles\`.`,
    `- If the target function IS \`static\` (internal linkage): a separate translation unit cannot link it. Your harness source MUST \`#include "<absolute path to the target file>"\` so the function compiles into the harness's own translation unit — and you must NOT also list that file in \`closureFiles\` (it would be defined twice).`,
    ``,
    `Choosing argument values: use the given path-constraint text to pick values that drive execution down the LEAKING branch (e.g. a condition text like \`flag == NULL\` means pass NULL for that parameter). A best-effort, plausible value beats no attempt — you do not need to be exhaustive.`,
    ``,
    `REQUIRED harness shape — the SAME source is compiled twice (once as a plain single run, once as a libFuzzer binary for a follow-up fuzz pass), so it must never define BOTH \`main()\` and \`LLVMFuzzerTestOneInput\` for the same build — linking libFuzzer already provides its own \`main()\`, and a harness with both is a duplicate-symbol error. Put the actual call in a \`static\` helper and switch the entry point on the \`HARNESS_FUZZ\` macro (the system defines it automatically for the fuzz build — you never set it):`,
    '```c',
    '/* extern-declare OR #include the target file per the linkage rule above */',
    'static void run_case(/* concrete or data-derived args */) {',
    '    /* the actual call that should reach the leaking branch */',
    '}',
    '#ifdef HARNESS_FUZZ',
    '#include <stdint.h>',
    '#include <stddef.h>',
    'int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {',
    '    /* derive AT LEAST ONE argument/buffer from data/size, then: */',
    '    run_case(/* ... */);',
    '    return 0;',
    '}',
    '#else',
    'int main(void) {',
    '    run_case(/* concrete values chosen from the path constraints */);',
    '    return 0;',
    '}',
    '#endif',
    '```',
    `Follow this skeleton exactly — same \`run_case\` body called from both branches, only the entry point differs.`,
    ``,
    `Tools:`,
    `- \`read_file\` — inspect the target file (and any header it needs) before writing the harness.`,
    `- \`buildHarness\` (projectPath="${analyzerProjectPath}", buildCommand, harnessSource, targetFile, closureFiles, entryStyle="single") — compiles+links your harness against the real project's own compiler flags. On reason="harness_unresolvable" (see its own description), stop and call ${DONE_HARNESS}, do not retry. Always call with entryStyle="single" — the system runs the fuzzer build itself later if needed.`,
    `- \`lsanRun\` (binaryPath) or \`asanRun\` (binaryPath) — run the compiled harness under a sanitizer, using the binaryPath \`buildHarness\` returned.`,
    ``,
    `Call buildHarness at most ONCE, then run one sanitizer on the result. If buildHarness fails for a reason other than harness_unresolvable, you may fix the harness source and try ONE more time. When a sanitizer has run (or the harness is unresolvable), call \`${DONE_HARNESS}\`. Do NOT reply with prose — only tool calls advance the work.`,
  ].join('\n');
}

/** Everything Stage A already learned about this ONE candidate — given directly so
 * the worker doesn't re-spend tool calls re-discovering it. `suggestedClosureFiles`
 * comes from an orchestrator-side `interproceduralFlow` call (deterministic, not the
 * worker's own tool call) — candidates for `closureFiles`, not a final answer; the
 * worker still decides what actually needs linking. */
export function harnessWorkerUserMessage(bundle: LeakBundle, staticCtx: Record<string, any>, suggestedClosureFiles: string[] = []): string {
  const c = bundle.candidate;
  const params = Array.isArray(staticCtx.parameters)
    ? staticCtx.parameters.map((p: any) => `${p.type ?? '?'} ${p.name ?? ''}`.trim()).join(', ')
    : '(unknown — read the file)';
  const constraints = Array.isArray(staticCtx.constraints) && staticCtx.constraints.length
    ? staticCtx.constraints.slice(0, 8).join('; ')
    : Array.isArray(staticCtx.feasibleLeakPaths) && staticCtx.feasibleLeakPaths.length
      ? staticCtx.feasibleLeakPaths.map((p: any) => p.narrative).slice(0, 5).join('; ')
      : '(none extracted — read the file to find the leaking branch)';
  return [
    `Candidate ${bundle.bundleId} — ${c.function_name || '?'}() at ${c.file_path}:${c.line_number} (${c.allocation_type || 'alloc'})`,
    ``,
    `Function signature: ${staticCtx.returnType ?? '?'} ${c.function_name}(${params})`,
    `Static linkage: ${staticCtx.isStaticLinkage ? 'static (internal — #include the source file, do not link separately)' : 'external (extern-declare + link)'}`,
    `Path constraints toward the leaking branch: ${constraints}`,
    `Known allocations: ${(staticCtx.allocations ?? []).join(', ') || 'none listed'} — frees: ${(staticCtx.frees ?? []).join(', ') || 'none listed'}`,
    suggestedClosureFiles.length
      ? `Files also in this function's call chain (candidates for closureFiles, if the leak needs a call into one of them): ${suggestedClosureFiles.join(', ')}`
      : '',
    ``,
    `Write a harness that reaches the leak, buildHarness it, run a sanitizer on the result, then call ${DONE_HARNESS}.`,
  ].join('\n');
}
