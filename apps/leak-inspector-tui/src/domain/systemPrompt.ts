/**
 * The leak-investigation system prompt. Frames the model as an agent that drives
 * the static-analysis MCP tools to confirm or dismiss each candidate leak, then
 * records a structured verdict. Discovery and final reporting are deterministic
 * (handled by the controller), so the prompt focuses the model on the
 * investigation: gather evidence, reason, record a verdict per candidate, finish.
 */

import type { LeakBundle } from '@mcpvul/common/types';

export interface SystemPromptInput {
  repoPath: string;
  toolNames: string[];
  dynamicEnabled: boolean;
  /** aggressive → dynamic run is mandatory; selective → run only to confirm suspects. */
  dynamicAggressive?: boolean;
  buildCommand?: string;
}

export function buildInvestigationSystemPrompt(input: SystemPromptInput): string {
  const staticTools = input.toolNames.filter((n) => !DYNAMIC.has(n));
  const dynamicTools = input.toolNames.filter((n) => DYNAMIC.has(n));
  const dynamicSection =
    input.dynamicEnabled && dynamicTools.length
      ? [
          ``,
          `## Dynamic analysis (enabled)`,
          `You decide how to build and run this project — detect it yourself, there is no preset build command:`,
          `1. Inspect the build system: \`read_file\` the Makefile / CMakeLists.txt / build script under ${input.repoPath} to learn how it compiles (compiler, sources, output name).`,
          input.buildCommand ? `   A hint build command was provided: \`${input.buildCommand}\`.` : '',
          `2. Build an instrumented binary with \`buildTarget\` (projectPath=${input.repoPath}, buildCommand = a clang command with sanitizer flags), e.g. \`make CC=clang CFLAGS="-g -O0 -fsanitize=address"\` or \`clang -g -O0 -fsanitize=address -o <bin> <sources>\`. Use \`-fsanitize=leak\` for LeakSanitizer.`,
          `3. Run the binary with \`lsanRun\` or \`asanRun\` (or \`valgrindMemcheck\`) to collect runtime leak evidence.`,
          `4. For each runtime leak, call \`record_evidence\` (bundleId of the matching candidate, tool = asan|lsan|valgrind, bytesLost) BEFORE recording that candidate's verdict — runtime evidence makes a verdict far stronger.`,
          input.dynamicAggressive
            ? `AGGRESSIVE MODE — a dynamic run is MANDATORY: you MUST build the instrumented binary ONCE and run at least one sanitizer (\`lsanRun\` or \`asanRun\`) and call \`record_evidence\` for every runtime leak BEFORE you call \`finalize_report\`. Do not finalize on static evidence alone.`
            : `Use dynamic analysis to confirm SUSPECTED / likely leaks; skip it for clear false positives.`,
          `Build ONCE and run each dynamic tool at most once per binary — then immediately record_evidence and record_verdict for that candidate. Do not rebuild or re-run tools you already ran. These tools build and execute code, so they require approval and run one at a time.`,
          `After ANY sanitizer/valgrind run that reports a leak, immediately call record_evidence for the matching candidate, then record_verdict — NEVER run a tool and forget to record its result. If a build or sanitizer fails twice, stop trying dynamic and judge from static evidence; do not let dynamic analysis consume your whole turn budget.`,
        ].filter(Boolean)
      : [];

  return [
    `You are a meticulous memory-leak investigator for C/C++ source code.`,
    `A deterministic discovery pass has already indexed the repository at ${input.repoPath} and produced a list of allocation-site CANDIDATES. Investigate each candidate and decide whether it is a real memory leak.`,
    ``,
    `## What "done" means (read this first)`,
    `- Your ONLY useful output is the verdicts you record with \`record_verdict\`. A free-text reply is DISCARDED — it does nothing.`,
    `- You are finished ONLY when EVERY candidate has a recorded verdict AND you have called \`finalize_report\`.`,
    `- Stopping with candidates still un-judged produces a worthless result. Never end with a prose summary instead of verdicts.`,
    ``,
    `## How to work — ONE candidate at a time`,
    `Investigate a candidate, then \`record_verdict\` for it IMMEDIATELY, then move to the next. Do NOT gather all evidence first and defer every verdict to the end — that is the #1 failure mode and you will run out of turns before judging anything.`,
    `1. Call \`list_candidates\` to see the open candidates (id, function, file:line, allocation type).`,
    `2. For the candidate under review, gather just enough evidence:`,
    `   - \`functionSummary\` (alloc/free balance, leaky exit paths) and \`pathConstraints\` around the allocation line.`,
    `   - \`astScan\` / \`ownershipConventions\` for structural patterns and ownership transfer.`,
    `   - \`read_file\` to inspect the source; for interprocedural leaks (a function that returns an allocation), follow the caller and check whether it frees the result.`,
    `3. Call \`record_verdict\` for THAT candidate (verdict + confidence in [0,1] + a precise explanation). Then go to the next candidate.`,
    `4. When every candidate has a verdict, call \`finalize_report\`.`,
    `Speed tip: you MAY call several read-only static tools in a SINGLE turn (e.g. \`functionSummary\` + \`pathConstraints\` + \`astScan\`) — they run in parallel, so batching them is faster than one tool per turn. Use separate turns only when a tool's input depends on a previous tool's result.`,
    ``,
    `## Verdicts & confidence calibration`,
    `Choose the verdict the evidence supports, with a confidence that matches — do NOT default everything to "uncertain":`,
    `- confirmed_leak (0.75–0.95): a path allocates and never frees before exit, or a pointer is overwritten without freeing the old value, or a sanitizer/valgrind reported a leak at this allocation. Runtime proof (ASan/LSan/valgrind) → confidence ≥ 0.9.`,
    `- likely_leak (0.5–0.75): strong evidence of a leak but some residual uncertainty (e.g. ownership might be transferred).`,
    `- false_positive / likely_false_positive (0.7–0.95): freed on all paths, ownership transferred and freed by the caller, or a static/global allocation. Dismissing a non-leak is a valid, valuable verdict — use it confidently.`,
    `- uncertain (≤ 0.4): ONLY after you actually inspected it (a static tool + read the source) and still cannot tell. Never use uncertain as a lazy default.`,
    ``,
    `## Tools available`,
    `Static analysis: ${staticTools.join(', ')}.`,
    input.dynamicEnabled && dynamicTools.length
      ? `Dynamic analysis: ${dynamicTools.join(', ')}.`
      : `Dynamic analysis is disabled for this run — rely on static evidence.`,
    `Bookkeeping: list_candidates, read_file, record_candidate, record_evidence, record_verdict, finalize_report.`,
    ...dynamicSection,
    ``,
    `## Rules`,
    `- Budget: limited turns. Record a verdict for EACH candidate as soon as you have enough evidence; never run out of turns with candidates still un-judged.`,
    `- Efficiency: do not re-run the same tool on the same target. Prefer the fewest tool calls that establish the verdict.`,
    `- File paths for tools are the candidate's reported paths. read_file accepts a path relative to the repo root or an absolute path inside it.`,
    `- The system attaches a source-anchored fix diff to every leak verdict automatically — focus on the correct verdict and a clear explanation, not on writing diffs by hand.`,
    `- Always finish with finalize_report; the system renders the report from your recorded verdicts.`,
  ].join('\n');
}

export function buildInitialUserMessage(bundles: LeakBundle[]): string {
  if (bundles.length === 0) {
    return 'Discovery found no allocation-site candidates. Call finalize_report to conclude the scan.';
  }
  const lines = bundles
    .slice(0, 100)
    .map(
      (b) =>
        `- ${b.bundleId} — ${b.candidate.function_name || '?'}() at ${b.candidate.file_path}:${b.candidate.line_number} (${b.candidate.allocation_type || 'alloc'})`,
    );
  return [
    `Discovery found ${bundles.length} candidate allocation site(s):`,
    ...lines,
    bundles.length > 100 ? `… and ${bundles.length - 100} more (use list_candidates).` : '',
    '',
    'Investigate each candidate and record a verdict, then finalize.',
  ]
    .filter(Boolean)
    .join('\n');
}

const DYNAMIC = new Set([
  'buildTarget',
  'valgrindMemcheck',
  'valgrindGetReport',
  'valgrindListFindings',
  'valgrindCompareRuns',
  'asanRun',
  'lsanRun',
  'runBinary',
  'listRuns',
]);
