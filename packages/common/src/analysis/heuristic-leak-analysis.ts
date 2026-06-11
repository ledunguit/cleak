/**
 * heuristic-leak-analysis — LLM-free root-cause classification + applicable
 * repair-diff synthesis for a leak bundle.
 *
 * Every "leak" verdict must ship a root-cause explanation AND an applicable fix
 * diff. The LLM judge does this opportunistically; the heuristic judge (the only
 * path in no_llm mode, and the fallback whenever no LLM key is configured) uses
 * this deterministic, source-anchored analysis:
 *
 *   - classify the LeakPatternType from the candidate + static context + source
 *   - build a LeakRootCause naming the allocation site and the missing-free site
 *   - synthesize a RepairDiff whose `originalLines` are copied verbatim from the
 *     real file at `startLine`, so the diff is guaranteed APPLICABLE (it matches
 *     the source and can be applied / reviewed as a genuine before/after).
 *
 * The synthesizer is intentionally conservative: when it cannot confidently
 * locate a better fix point it falls back to inserting `free(<var>)` before the
 * enclosing function's final exit — always a real, applicable anchor.
 */
import { LeakBundle, LeakCandidate, LeakRootCause, LeakPatternType, RepairDiff } from '../types';

export interface HeuristicAnalysis {
  patternType: LeakPatternType;
  rootCause: LeakRootCause;
  /** Undefined only when no source is available at all. */
  repairDiff?: RepairDiff;
  /** Richer natural-language root-cause narrative (supersedes the score string). */
  explanation: string;
  /** Ordered human-readable allocation→leak flow steps. */
  codeFlow: string[];
  /**
   * How strongly the source-level structural analysis indicates a real leak —
   * used as static evidence by the heuristic judge:
   *   high   = a concrete missing-free was located (interprocedural caller drop,
   *            early return before free, loop overwrite, realloc-onto-self, or
   *            an allocation never freed anywhere in its function)
   *   medium = a leak pattern matched but the missing-free site is less certain
   *   low    = the variable appears freed, or the analysis could not confirm a leak
   */
  structuralLikelihood: 'high' | 'medium' | 'low';
  /**
   * Set when the allocated pointer is handed to a callee that frees it (1-hop
   * interprocedural). The buffer is the sink's responsibility, so this is NOT a
   * leak — the judge should dismiss it (the Juliet good*→goodSink pattern). Absent
   * for a bad sink that does not free, so real leaks are preserved.
   */
  freedViaCallee?: { callee: string; variable: string };
}

const ALLOC_FNS =
  'malloc|calloc|realloc|reallocarray|strdup|strndup|aligned_alloc|valloc|memalign|posix_memalign|g_malloc|g_malloc0|g_strdup|asprintf';

export interface FunctionBounds {
  /** 0-based line index of the line containing the opening brace. */
  startIdx: number;
  /** 0-based line index of the matching closing brace. */
  endIdx: number;
}

/** Leading whitespace of a line (for indentation-matched insertions). */
function indentOf(line: string): string {
  const m = line.match(/^(\s*)/);
  return m ? m[1] : '';
}

/**
 * Find the pointer variable assigned at (or near) the allocation line.
 * Handles `T *p = malloc(...)`, `p = (T*)calloc(...)`, `p = realloc(p, n)`.
 *
 * Candidate line numbers are not always exact — some are reported at the
 * function signature a few lines above the actual call — so search a window and
 * prefer the closest allocation whose function matches the candidate's
 * allocation_type hint.
 */
function findAllocVar(
  lines: string[],
  allocIdx: number,
  allocTypeHint?: string,
): { varName: string | null; allocFn: string | null; lineIdx: number } {
  const re = new RegExp(`([A-Za-z_]\\w*)\\s*=\\s*(?:\\([^)]*\\)\\s*)?(?:[A-Za-z_]\\w*\\s*\\(\\s*)?\\b(${ALLOC_FNS})\\b`);
  const hint = (allocTypeHint || '').toLowerCase();
  const matches: Array<{ varName: string; allocFn: string; lineIdx: number; dist: number }> = [];
  for (let idx = Math.max(0, allocIdx - 3); idx <= Math.min(lines.length - 1, allocIdx + 12); idx++) {
    const m = lines[idx].match(re);
    if (m) matches.push({ varName: m[1], allocFn: m[2], lineIdx: idx, dist: Math.abs(idx - allocIdx) });
  }
  if (matches.length === 0) return { varName: null, allocFn: null, lineIdx: allocIdx };
  if (hint) {
    const hinted = matches
      .filter((m) => hint.includes(m.allocFn.toLowerCase()) || m.allocFn.toLowerCase().includes(hint))
      .sort((a, b) => a.dist - b.dist);
    if (hinted.length) return hinted[0];
  }
  matches.sort((a, b) => a.dist - b.dist);
  return matches[0];
}

const BLOCK_KEYWORD_RE = /^\s*\}?\s*(?:if|for|while|switch|else|do)\b/;

/**
 * Is the unmatched `{` at `braceIdx` a FUNCTION's opening brace (vs an
 * if/else/loop/switch block)? Looks at the brace line and up to 2 lines above
 * for a `name(args)` signature whose name is not a control keyword.
 */
function looksLikeFunctionOpen(lines: string[], braceIdx: number): boolean {
  for (let j = braceIdx; j >= Math.max(0, braceIdx - 2); j--) {
    const l = lines[j];
    if (j < braceIdx && !l.trim()) continue; // skip blank lines above the brace
    if (BLOCK_KEYWORD_RE.test(l)) return false;
    const m = l.match(/([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{?\s*$/);
    if (m && !['if', 'for', 'while', 'switch', 'return', 'sizeof'].includes(m[1])) return true;
    if (j < braceIdx && l.trim()) return false; // some other statement — not a signature
  }
  return false;
}

/** Locate the enclosing FUNCTION body via brace matching around the allocation. */
export function findEnclosingFunction(lines: string[], allocIdx: number): FunctionBounds | null {
  // Walk backwards counting net brace depth. Each unmatched `{` steps one block
  // out — but only stop at the FUNCTION's brace: an allocation inside
  // `if(1) { ... }` (Juliet control-flow variants) must not be bounded to the
  // if-block, or every free/sink below the block is invisible to the analysis.
  let depth = 0;
  let startIdx = -1;
  for (let i = allocIdx; i >= 0; i--) {
    const opens = (lines[i].match(/\{/g) || []).length;
    const closes = (lines[i].match(/\}/g) || []).length;
    depth += closes - opens;
    if (depth < 0) {
      if (looksLikeFunctionOpen(lines, i)) {
        startIdx = i;
        break;
      }
      depth = 0; // a block brace (if/else/loop/switch) — step out and keep climbing
    }
  }
  if (startIdx < 0) return null;
  // Walk forward from the opening brace to its match.
  let bd = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    const opens = (lines[i].match(/\{/g) || []).length;
    const closes = (lines[i].match(/\}/g) || []).length;
    if (opens > 0) started = true;
    bd += opens - closes;
    if (started && bd <= 0) {
      return { startIdx, endIdx: i };
    }
  }
  return { startIdx, endIdx: lines.length - 1 };
}

/** True if any line in [from, to] frees `varName`. */
function hasFreeOfVar(lines: string[], from: number, to: number, varName: string): boolean {
  const re = new RegExp(`\\bfree\\s*\\(\\s*${varName}\\b`);
  for (let i = from; i <= to && i < lines.length; i++) {
    if (re.test(lines[i])) return true;
  }
  return false;
}

/** Detect whether the function returns `varName` (ownership transfer to caller). */
function returnsVar(lines: string[], fn: FunctionBounds, varName: string): boolean {
  const re = new RegExp(`\\breturn\\s+(?:\\([^)]*\\)\\s*)?\\*?${varName}\\b`);
  for (let i = fn.startIdx; i <= fn.endIdx; i++) {
    if (re.test(lines[i])) return true;
  }
  return false;
}

/**
 * A `return` reached on a branch where the var is known NULL (e.g. inside
 * `if (var == NULL)` / `if (!var)`) is not a leaking exit — freeing there is a
 * no-op and misses the real leak. Detect that guard in the few lines above.
 */
function isNullGuardedReturn(lines: string[], returnIdx: number, varName: string): boolean {
  const guard = new RegExp(
    `\\bif\\s*\\(\\s*(?:!\\s*${varName}\\b|${varName}\\s*==\\s*(?:NULL|0|nullptr)|(?:NULL|0|nullptr)\\s*==\\s*${varName})\\b`,
  );
  for (let j = returnIdx; j >= Math.max(0, returnIdx - 3); j--) {
    if (guard.test(lines[j])) return true;
    // Stop if we cross a closing brace that isn't the guard's own block opener.
    if (j < returnIdx && /\belse\b/.test(lines[j])) break;
  }
  return false;
}

/** Index of the first leaking `return`/`goto` exit after the allocation that does not free the var. */
function findEarlyLeakingExit(lines: string[], allocIdx: number, fn: FunctionBounds, varName: string): number {
  for (let i = allocIdx + 1; i < fn.endIdx; i++) {
    if (/\breturn\b/.test(lines[i]) || /\bgoto\b/.test(lines[i]) || /\bexit\s*\(/.test(lines[i])) {
      // A return that already frees the var on the same line is not leaking.
      if (new RegExp(`\\bfree\\s*\\(\\s*${varName}\\b`).test(lines[i])) continue;
      // A return guarded by a NULL-check on the var carries a NULL pointer, not a leak.
      if (isNullGuardedReturn(lines, i, varName)) continue;
      if (!hasFreeOfVar(lines, allocIdx + 1, i, varName)) return i;
    }
  }
  return -1;
}

/** The function's terminal exit line (last `return` or the closing brace). */
function findFinalExit(lines: string[], fn: FunctionBounds): number {
  for (let i = fn.endIdx; i > fn.startIdx; i--) {
    if (/\breturn\b/.test(lines[i])) return i;
  }
  return fn.endIdx; // closing brace
}

/** Is the allocation inside a loop body within the function? */
function loopEnclosingAlloc(lines: string[], allocIdx: number, fn: FunctionBounds): number {
  for (let i = allocIdx; i > fn.startIdx; i--) {
    if (/^\s*(for|while)\s*\(/.test(lines[i]) || /\b(for|while)\s*\(/.test(lines[i])) {
      // crude: treat the nearest preceding loop header as the enclosing loop
      return i;
    }
    if (/^\s*\}/.test(lines[i])) break; // left a block before hitting a loop header
  }
  return -1;
}

/** Closing brace index of a loop whose header is at headerIdx. */
function blockEnd(lines: string[], headerIdx: number): number {
  let bd = 0;
  let started = false;
  for (let i = headerIdx; i < lines.length; i++) {
    const opens = (lines[i].match(/\{/g) || []).length;
    const closes = (lines[i].match(/\}/g) || []).length;
    if (opens > 0) started = true;
    bd += opens - closes;
    if (started && bd <= 0) return i;
  }
  return headerIdx;
}

/** Brace-match a function body starting at its signature line. */
function bodyBounds(lines: string[], sigIdx: number): FunctionBounds | null {
  let open = -1;
  for (let j = sigIdx; j <= Math.min(sigIdx + 3, lines.length - 1); j++) {
    if (lines[j].includes('{')) {
      open = j;
      break;
    }
  }
  if (open < 0) return null;
  let bd = 0;
  let started = false;
  for (let i = open; i < lines.length; i++) {
    const o = (lines[i].match(/\{/g) || []).length;
    const c = (lines[i].match(/\}/g) || []).length;
    if (o > 0) started = true;
    bd += o - c;
    if (started && bd <= 0) return { startIdx: sigIdx, endIdx: i };
  }
  return { startIdx: sigIdx, endIdx: lines.length - 1 };
}

/** Find the DEFINITION (not a call/prototype) of a function named `name`. */
function findFunctionDefBounds(lines: string[], name: string): FunctionBounds | null {
  const def = new RegExp(`^\\s*(?:static\\s+)?[A-Za-z_][\\w\\s\\*]*\\b${name}\\s*\\([^;]*\\)\\s*\\{?\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (def.test(lines[i])) return bodyBounds(lines, i);
  }
  return null;
}

/** Pointer parameter names from a signature line, e.g. `void f(char * data)` → [data]. */
function pointerParams(sigLine: string): string[] {
  const inner = (sigLine.match(/\(([^)]*)\)/) || [])[1] || '';
  return inner
    .split(',')
    .map((p) => {
      const m = p.match(/\*\s*([A-Za-z_]\w*)\s*$/);
      return m ? m[1] : null;
    })
    .filter((x): x is string => !!x);
}

const NON_SINK_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'sizeof', 'return', 'free', 'malloc', 'calloc', 'realloc',
  'strdup', 'memset', 'memcpy', 'strcpy', 'strncpy', 'printLine', 'printIntLine', 'exit',
  'printf', 'fprintf', 'snprintf', 'sprintf',
]);

/**
 * 1-hop interprocedural free: is `varName` passed to a callee (defined in this
 * file) that frees the corresponding pointer? Distinguishes the Juliet
 * good*→goodSink (frees) pattern from bad→badSink (does not free).
 */
export function isFreedViaCallee(
  lines: string[],
  caller: FunctionBounds,
  varName: string,
): { callee: string } | null {
  const callRe = /\b([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
  const argHas = new RegExp(`\\b${varName}\\b`);
  for (let i = caller.startIdx; i <= caller.endIdx && i < lines.length; i++) {
    callRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(lines[i]))) {
      const callee = m[1];
      const args = m[2];
      if (NON_SINK_CALLS.has(callee) || !argHas.test(args)) continue;
      const def = findFunctionDefBounds(lines, callee);
      if (!def) continue;
      for (const p of pointerParams(lines[def.startIdx])) {
        if (hasFreeOfVar(lines, def.startIdx, def.endIdx, p)) return { callee };
      }
    }
  }
  return null;
}

/** Locate a caller of `fnName` elsewhere in the file (for interprocedural leaks). */
function findCallerAssignment(
  lines: string[],
  fnName: string,
  skipFn: FunctionBounds,
): { callIdx: number; callerVar: string } | null {
  const re = new RegExp(`([A-Za-z_]\\w*)\\s*=\\s*(?:\\([^)]*\\)\\s*)?${fnName}\\s*\\(`);
  for (let i = 0; i < lines.length; i++) {
    if (i >= skipFn.startIdx && i <= skipFn.endIdx) continue; // skip the definition
    const m = lines[i].match(re);
    if (m) return { callIdx: i, callerVar: m[1] };
  }
  return null;
}

function classifyPattern(
  candidate: LeakCandidate,
  ctx: Record<string, any> | undefined,
  facts: { allocFn: string | null; returned: boolean; inLoop: boolean; hasEarlyExit: boolean },
): LeakPatternType {
  const allocType = (candidate.allocation_type || '').toLowerCase();
  const allocFn = (facts.allocFn || '').toLowerCase();
  if (allocFn.includes('realloc') || allocType.includes('realloc')) return LeakPatternType.REALLOC_MISHANDLE;
  if (facts.inLoop || Number(ctx?.loopsWithAllocations || 0) > 0) return LeakPatternType.LOOP_ACCUMULATE;
  if (facts.returned) return LeakPatternType.INTERPROCEDURAL_LEAK;
  if (facts.hasEarlyExit || Number(ctx?.earlyReturnCount || 0) > 0) return LeakPatternType.EARLY_RETURN;
  if (allocFn.includes('strdup') || allocType.includes('strdup')) return LeakPatternType.STRDUP_LEAK;
  return LeakPatternType.UNKNOWN;
}

function describePattern(p: LeakPatternType): string {
  switch (p) {
    case LeakPatternType.EARLY_RETURN:
      return 'an early return leaves the function before the allocated memory is freed';
    case LeakPatternType.LOOP_ACCUMULATE:
      return 'each loop iteration overwrites the pointer without freeing the previous allocation';
    case LeakPatternType.REALLOC_MISHANDLE:
      return 'realloc result is assigned back onto the original pointer, losing it (and leaking) if realloc fails';
    case LeakPatternType.INTERPROCEDURAL_LEAK:
      return 'the function transfers ownership by returning the allocation, but the caller never frees it';
    case LeakPatternType.STRDUP_LEAK:
      return 'the duplicated string is never freed before the function exits';
    default:
      return 'memory is allocated but no matching free is reached on at least one exit path';
  }
}

/**
 * Run the heuristic analysis. `fileContent` is the full source of
 * candidate.file_path (or null if unreadable).
 */
export function analyzeLeakHeuristically(
  bundle: LeakBundle,
  ctx: Record<string, any> | undefined,
  fileContent: string | null,
): HeuristicAnalysis {
  const candidate = bundle.candidate;
  const allocLine = candidate.line_number || 0;
  const allocFile = candidate.file_path;
  const allocFnName = candidate.function_name || 'this function';

  // Without source we can still classify and explain, but cannot anchor a diff.
  if (!fileContent || allocLine <= 0) {
    const pattern = classifyPattern(candidate, ctx, {
      allocFn: candidate.allocation_type,
      returned: false,
      inLoop: Number(ctx?.loopsWithAllocations || 0) > 0,
      hasEarlyExit: Number(ctx?.earlyReturnCount || 0) > 0,
    });
    return {
      patternType: pattern,
      rootCause: baseRootCause(candidate, pattern, allocLine, allocFnName),
      explanation: `Likely ${pattern} at ${allocFile}:${allocLine}: ${describePattern(pattern)}.`,
      codeFlow: [`Allocation at ${allocFile}:${allocLine} in ${allocFnName}()`],
      // No source to inspect — lean on whatever static signals the context carries.
      structuralLikelihood:
        Number(ctx?.loopsWithAllocations || 0) > 0 || Number(ctx?.earlyReturnCount || 0) > 0 ? 'medium' : 'low',
    };
  }

  const lines = fileContent.split('\n');
  const candIdx = Math.min(Math.max(allocLine - 1, 0), lines.length - 1);
  const { varName, allocFn, lineIdx: allocLineIdx } = findAllocVar(lines, candIdx, candidate.allocation_type);
  // Anchor all structural reasoning on the REAL allocation line (the candidate
  // line can point a few lines off, e.g. at the function signature).
  const allocIdx = varName ? allocLineIdx : candIdx;
  const realAllocLine = allocIdx + 1;
  const fn = findEnclosingFunction(lines, allocIdx);
  const v = varName || 'ptr';

  const fnBounds: FunctionBounds = fn || { startIdx: allocIdx, endIdx: Math.min(allocIdx + 20, lines.length - 1) };
  const returned = varName ? returnsVar(lines, fnBounds, v) : false;
  // 1-hop interprocedural free: the pointer is handed to a sink that frees it.
  const freedViaCalleeHit = varName ? isFreedViaCallee(lines, fnBounds, v) : null;
  const loopHeader = loopEnclosingAlloc(lines, allocIdx, fnBounds);
  const inLoop = loopHeader >= 0;
  const earlyExitIdx = varName ? findEarlyLeakingExit(lines, allocIdx, fnBounds, v) : -1;

  const pattern = classifyPattern(candidate, ctx, {
    allocFn,
    returned,
    inLoop,
    hasEarlyExit: earlyExitIdx >= 0,
  });

  const codeFlow: string[] = [
    `${allocFnName}() allocates via ${allocFn || candidate.allocation_type || 'malloc'} at ${allocFile}:${realAllocLine}` +
      (varName ? ` into \`${v}\`` : ''),
  ];

  let repairDiff: RepairDiff | undefined;
  let missingFreeLine = allocLine;
  let missingFreeFunction = allocFnName;
  let rootCauseDescription = describePattern(pattern);
  let structuralLikelihood: 'high' | 'medium' | 'low' = 'low';

  // ── Synthesize an applicable, source-anchored diff per pattern ──
  if (pattern === LeakPatternType.REALLOC_MISHANDLE && varName) {
    // Replace `p = realloc(p, n)` with a temp-variable guard.
    const { lineIdx } = findAllocVar(lines, allocIdx, candidate.allocation_type);
    const orig = lines[lineIdx];
    const ind = indentOf(orig);
    const inner = orig.match(/realloc\s*\(([^;]*)\)/);
    const args = inner ? inner[1] : `${v}, /* size */`;
    repairDiff = {
      filePath: allocFile,
      originalLines: [orig],
      suggestedLines: [
        `${ind}void *tmp_${v} = realloc(${args});`,
        `${ind}if (tmp_${v} == NULL) { free(${v}); /* handle allocation failure */ return; }`,
        `${ind}${v} = tmp_${v};`,
      ],
      startLine: lineIdx + 1,
      description: `Use a temporary for the realloc result so the original \`${v}\` is not lost (and leaked) when realloc fails.`,
    };
    missingFreeLine = lineIdx + 1;
    rootCauseDescription = `\`${v} = realloc(${v}, …)\` overwrites the only pointer to the block; if realloc returns NULL the original allocation is leaked.`;
    structuralLikelihood = 'high';
  } else if (returned && varName) {
    // Interprocedural: fix belongs in the caller.
    const caller = findCallerAssignment(lines, allocFnName, fnBounds);
    if (caller) {
      const callerFn = findEnclosingFunction(lines, caller.callIdx);
      const cb = callerFn || { startIdx: caller.callIdx, endIdx: Math.min(caller.callIdx + 20, lines.length - 1) };
      let anchor = findEarlyLeakingExit(lines, caller.callIdx, cb, caller.callerVar);
      if (anchor < 0) anchor = findFinalExit(lines, cb);
      repairDiff = insertFreeBefore(lines, anchor, caller.callerVar, allocFile);
      missingFreeLine = anchor + 1;
      missingFreeFunction = functionNameAt(lines, cb.startIdx) || 'the caller';
      codeFlow.push(`${allocFnName}() returns \`${v}\`, transferring ownership to the caller`);
      codeFlow.push(`caller assigns it to \`${caller.callerVar}\` at ${allocFile}:${caller.callIdx + 1} but never frees it`);
      rootCauseDescription = `\`${allocFnName}()\` returns the allocation; the caller (\`${missingFreeFunction}\`) drops \`${caller.callerVar}\` without calling free().`;
      // Confirmed only if the caller does not itself free the returned pointer.
      structuralLikelihood = hasFreeOfVar(lines, caller.callIdx, cb.endIdx, caller.callerVar) ? 'low' : 'high';
    } else {
      // Caller not in this file: anchor a best-effort free at the function's exit
      // is wrong (it returns the value), so emit guidance without a misleading diff.
      rootCauseDescription = `\`${allocFnName}()\` returns the allocated \`${v}\`; ownership transfers to its caller, which must free it. The caller was not found in this file.`;
      codeFlow.push(`${allocFnName}() returns \`${v}\` — the matching free must live in the (external) caller`);
      structuralLikelihood = 'medium';
    }
  } else if (inLoop && varName) {
    // Loop accumulation: free at the end of the loop body before the next iteration.
    const loopClose = blockEnd(lines, loopHeader);
    const anchor = Math.max(loopClose, allocIdx + 1);
    repairDiff = insertFreeBefore(lines, anchor, v, allocFile, /*freePrev*/ true);
    missingFreeLine = anchor + 1;
    rootCauseDescription = `The loop starting at ${allocFile}:${loopHeader + 1} reassigns \`${v}\` each iteration without freeing the previous allocation.`;
    codeFlow.push(`loop body reassigns \`${v}\` every iteration, orphaning the prior block`);
    structuralLikelihood = 'high';
  } else if (earlyExitIdx >= 0 && varName) {
    // Early return before cleanup.
    repairDiff = insertFreeBefore(lines, earlyExitIdx, v, allocFile);
    missingFreeLine = earlyExitIdx + 1;
    rootCauseDescription = `The early exit at ${allocFile}:${earlyExitIdx + 1} returns before \`${v}\` is freed.`;
    codeFlow.push(`exit at line ${earlyExitIdx + 1} is reached before any free(${v})`);
    structuralLikelihood = 'high';
  } else if (varName) {
    // Generic missing free: insert before the function's terminal exit. This is a
    // real leak only if the variable is never freed anywhere in its function.
    const anchor = findFinalExit(lines, fnBounds);
    const freedAnywhere = hasFreeOfVar(lines, fnBounds.startIdx, fnBounds.endIdx, v);
    repairDiff = insertFreeBefore(lines, anchor, v, allocFile);
    missingFreeLine = anchor + 1;
    rootCauseDescription = freedAnywhere
      ? `\`${v}\` is freed on some paths but may not be released before every exit of ${allocFnName}().`
      : `\`${v}\` allocated at ${allocFile}:${allocLine} is never freed before ${allocFnName}() returns.`;
    codeFlow.push(`${allocFnName}() returns at line ${anchor + 1} without freeing \`${v}\``);
    structuralLikelihood = freedAnywhere ? 'low' : 'high';
  }

  // Interprocedural free overrides a "missing free" conclusion: the pointer is
  // the sink's responsibility (Juliet good*→goodSink). Not a leak. Don't override
  // the `returned`/realloc ownership cases (those are genuine caller-side leaks).
  if (freedViaCalleeHit && !returned && pattern !== LeakPatternType.REALLOC_MISHANDLE) {
    structuralLikelihood = 'low';
    repairDiff = undefined;
    rootCauseDescription = `\`${v}\` is passed to \`${freedViaCalleeHit.callee}()\`, which frees it — ownership is consumed by the sink, not leaked.`;
    codeFlow.push(`\`${v}\` is handed to \`${freedViaCalleeHit.callee}()\` which calls free() — no leak`);
  }

  const rootCause: LeakRootCause = {
    patternType: pattern,
    description: describePattern(pattern),
    allocationFunction: allocFnName,
    allocationLine: realAllocLine,
    allocationFile: allocFile,
    missingFreeLine,
    missingFreeFunction,
    rootCauseFunction: missingFreeFunction,
    rootCauseLine: missingFreeLine,
    rootCauseDescription,
  };

  const explanation =
    freedViaCalleeHit && structuralLikelihood === 'low'
      ? rootCauseDescription
      : `${capitalize(pattern.replace(/_/g, ' '))}: ${rootCauseDescription} ` +
        `The allocation at ${allocFile}:${realAllocLine}${varName ? ` (\`${v}\`)` : ''} has no matching free on the leaking path.`;

  return {
    patternType: pattern,
    rootCause,
    repairDiff,
    explanation,
    codeFlow,
    structuralLikelihood,
    ...(freedViaCalleeHit && structuralLikelihood === 'low'
      ? { freedViaCallee: { callee: freedViaCalleeHit.callee, variable: v } }
      : {}),
  };
}

/** Build a free()-insertion diff anchored verbatim on the line at `anchorIdx`. */
function insertFreeBefore(
  lines: string[],
  anchorIdx: number,
  varName: string,
  filePath: string,
  freePrev = false,
): RepairDiff {
  const safeIdx = Math.min(Math.max(anchorIdx, 0), lines.length - 1);
  const anchor = lines[safeIdx];
  const ind = indentOf(anchor);
  const freeStmt = freePrev
    ? `${ind}free(${varName}); /* free previous iteration's allocation */`
    : `${ind}free(${varName});`;
  return {
    filePath,
    originalLines: [anchor],
    suggestedLines: [freeStmt, anchor],
    startLine: safeIdx + 1,
    description: `Free \`${varName}\` before the exit at line ${safeIdx + 1} so every path releases the allocation.`,
  };
}

function baseRootCause(
  candidate: LeakCandidate,
  pattern: LeakPatternType,
  allocLine: number,
  fnName: string,
): LeakRootCause {
  return {
    patternType: pattern,
    description: describePattern(pattern),
    allocationFunction: fnName,
    allocationLine: allocLine,
    allocationFile: candidate.file_path,
    rootCauseFunction: fnName,
    rootCauseLine: allocLine,
    rootCauseDescription: describePattern(pattern),
  };
}

/** Best-effort function name from a signature line (e.g. `int main(void) {`). */
function functionNameAt(lines: string[], startIdx: number): string | null {
  for (const i of [startIdx, startIdx - 1]) {
    if (i < 0 || i >= lines.length) continue;
    const m = lines[i].match(/([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{?\s*$/);
    if (m && m[1] !== 'if' && m[1] !== 'for' && m[1] !== 'while' && m[1] !== 'switch') return m[1];
  }
  return null;
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
