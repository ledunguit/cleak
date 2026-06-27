import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import { CParserService, type FunctionInfo } from './c-parser.service';

const ALLOC_PATTERNS = [
  /\bmalloc\s*\(/g,
  /\bcalloc\s*\(/g,
  /\brealloc\s*\(/g,
  /\bstrdup\s*\(/g,
  /\bxmalloc\s*\(/g,
  /\bxcalloc\s*\(/g,
  /\bxrealloc\s*\(/g,
  /\bxstrdup\s*\(/g,
  /\bnew\s+/g,
  // Allocator-aware discovery for REAL projects, which routinely wrap libc behind
  // custom allocators (e.g. cJSON's `global_hooks.allocate(...)`, `pool_alloc()`).
  // A lexical scan that knows only malloc/calloc misses these, so the leak is never
  // even discovered as a candidate. These match an allocator NAMED "alloc…" or
  // "…_alloc…" — `\balloc` requires a word boundary, so `deallocate`/`free` are NOT
  // matched (the "alloc" in "deallocate" is mid-word), keeping it precise.
  /\balloc\w*\s*\(/gi,
  /\b\w+_alloc\w*\s*\(/gi,
  // NOTE: a generic `\w+_(m|c|re)alloc` / `\w+_strn?dup` wrapper pattern was tried
  // here but it OVER-MATCHES — it treats a function NAME like Juliet's
  // `char_calloc_01_bad(` as an allocation call, doubling candidates and tanking
  // precision (FP 7→44 on Juliet). Prefixed libc wrappers (cJSON_malloc, g_realloc)
  // are instead supplied as EXACT per-project names via `extraAllocators` (≈ LAMeD
  // AllocSource), which is precise. See namePatterns() below.
];

const FREE_PATTERNS = [
  /\bfree\s*\(/g,
  /\bxfree\s*\(/g,
  /\bdelete\s+/g,
  /\bdelete\s*\[\s*\]/g,
  // Symmetric custom-deallocator awareness so a custom-allocated pointer that IS
  // freed (cJSON_free / cJSON_Delete / global_hooks.deallocate / pool_free) is not
  // mistaken for a leak. `free` must abut `(` so "freeze(" is not a free.
  /\b\w*free\s*\(/gi,
  /\bdealloc\w*\s*\(/gi,
  /\b\w+_delete\s*\(/gi,
];

const RETURN_PATTERN = /\breturn\b/g;

/**
 * Build `\bNAME\s*\(` matchers from a list of function names. Real projects expose
 * FACTORY allocators / custom deallocators whose names carry no malloc/alloc/free
 * token — cJSON's leaks flow through `cJSON_Duplicate` / `cJSON_CreateObject`
 * (→ `cJSON_New_Item`); deallocation via `cJSON_Delete`. These are invisible to the
 * lexical patterns (the single biggest real-project DISCOVERY gap on LAMeD: no
 * candidate at the leak site → neither heuristic nor LLM can flag it). This is the
 * same signal LAMeD generates as AllocSource/FreeSink annotations; supplied here as
 * a PER-PROJECT list. `names` (from the corpus manifest, threaded per scan) takes
 * precedence; the `env*` var is a fallback for ad-hoc scans. Only safe identifiers.
 */
/**
 * Pick the INNERMOST enclosing function name for a 1-based line: among functions whose
 * [lineNumber, endLine] range contains the line, the smallest range wins (handles
 * nesting / shared boundaries). Returns null when no function contains the line, so the
 * caller can fall back to the lexical scan. Pure + exported so it is unit-testable on
 * the host (tree-sitter itself only loads in the Linux container).
 */
export function enclosingFunctionName(
  line: number,
  functions: { functionName: string; lineNumber: number; endLine: number }[],
): string | null {
  let best: { functionName: string; lineNumber: number; endLine: number } | null = null;
  for (const fn of functions) {
    if (fn.lineNumber <= line && line <= fn.endLine) {
      if (!best || fn.endLine - fn.lineNumber < best.endLine - best.lineNumber) best = fn;
    }
  }
  return best?.functionName ?? null;
}

function namePatterns(names: string[] | undefined, envVar: string): RegExp[] {
  const list = names?.length ? names : (process.env[envVar] || '').split(',');
  return list
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_]\w*$/.test(s))
    .map((n) => new RegExp(`\\b${n}\\s*\\(`, 'g'));
}

@Injectable()
export class CandidateScanService {
  constructor(private readonly cParser: CParserService) {}

  scan(filePath: string, content?: string, extraAllocators?: string[], extraDeallocators?: string[]) {
    const allocPatterns = [...ALLOC_PATTERNS, ...namePatterns(extraAllocators, 'EXTRA_ALLOCATOR_NAMES')];
    const freePatterns = [...FREE_PATTERNS, ...namePatterns(extraDeallocators, 'EXTRA_DEALLOCATOR_NAMES')];
    const source = content || readFileSync(filePath, 'utf-8');
    // Parse once (cached by content+allocators → the enrichment stage reuses it) to get
    // ACCURATE function boundaries for attributing each candidate to its enclosing
    // function. LAMeD scores function-level, so a wrong attribution = a missed flaw.
    let functions: FunctionInfo[] = [];
    try {
      functions = this.cParser.parse(source, filePath, extraAllocators, extraDeallocators).functions;
    } catch {
      functions = []; // fall back to the lexical scan below
    }
    const sanitized = this.sanitizeSource(source);
    const lines = source.split('\n');
    const sanitizedLines = sanitized.split('\n');
    const candidates: any[] = [];
    let candidateId = 0;

    const allFreeLines: number[] = [];
    for (let i = 0; i < sanitizedLines.length; i++) {
      for (const pattern of freePatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(sanitizedLines[i])) {
          allFreeLines.push(i + 1);
          break;
        }
      }
    }

    const allReturnLines: number[] = [];
    for (let i = 0; i < sanitizedLines.length; i++) {
      RETURN_PATTERN.lastIndex = 0;
      if (RETURN_PATTERN.test(sanitizedLines[i])) {
        allReturnLines.push(i + 1);
      }
    }

    for (let i = 0; i < sanitizedLines.length; i++) {
      const line = sanitizedLines[i];
      const lineNumber = i + 1;

      for (const pattern of allocPatterns) {
        pattern.lastIndex = 0;
        const match = pattern.exec(line);
        if (match) {
          const funcName = enclosingFunctionName(lineNumber, functions) ?? this.extractFunctionName(lines, i);
          candidateId++;
          candidates.push({
            id: `static-candidate-${String(candidateId).padStart(4, '0')}`,
            functionName: funcName,
            filePath: filePath,
            lineNumber: lineNumber,
            allocationSite: `${filePath}:${lineNumber}:${match[0].replace(/\s*\(/, '').trim()}`,
            allocationType: match[0].replace(/\s*\(/, '').trim(),
            confidence: 'medium',
            context: lines[i].trim(),
            signature: `${filePath}:${lineNumber}:allocation`,
            observedDeallocationCount: allFreeLines.length,
            earlyReturnLines: allReturnLines,
          });
          break; // one allocation per line
        }
      }
    }

    return { candidates };
  }

  private sanitizeSource(source: string): string {
    // Remove comments and string/char literals while preserving line numbers
    const lines = source.split('\n');
    const result: string[] = [];

    for (const line of lines) {
      let sanitized = line;
      // Remove string literals
      sanitized = sanitized.replace(/"(?:\\.|[^"\\])*"/g, (m) =>
        ' '.repeat(m.length),
      );
      // Remove char literals
      sanitized = sanitized.replace(/'(?:\\.|[^'\\])*'/g, (m) =>
        ' '.repeat(m.length),
      );
      // Remove single-line comments
      sanitized = sanitized.replace(/\/\/.*$/, '');
      result.push(sanitized);
    }

    // Remove multi-line comments — but PRESERVE newlines so line numbers don't
    // shift. Replacing a `/* … */` block with '' would delete its inner newlines
    // and collapse every following line upward (Juliet files open with a ~14-line
    // header comment), mis-anchoring candidate line numbers and breaking the
    // sanitized↔original index alignment that extractFunctionName relies on.
    let joined = result.join('\n');
    joined = joined.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    return joined;
  }

  /** Lexical fallback (parse failure / file-scope): backscan ≤20 lines for a signature. */
  private extractFunctionName(lines: string[], lineIndex: number): string {
    const funcPattern = /^(?:static\s+)?\w+(?:\s*\*)?\s*(\w+)\s*\(/;
    for (let i = lineIndex; i >= Math.max(0, lineIndex - 20); i--) {
      const match = funcPattern.exec(lines[i]);
      if (match) return match[1];
    }
    return 'unknown';
  }
}
