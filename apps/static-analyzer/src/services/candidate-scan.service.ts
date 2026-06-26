import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';

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
  // Custom libc WRAPPERS with a prefix: cJSON_malloc, g_realloc, my_calloc,
  // apr_strdup. These miss the patterns above (`_malloc` is not `_alloc`, and the
  // `_` before `malloc` removes the `\b` word boundary) yet are the most common
  // real-project allocator shape — cJSON's leaks all flow through `cJSON_malloc`.
  // `free`/`*_free`/`dealloc` never match (no `_malloc/_calloc/_realloc/_strdup`).
  /\b\w+_(?:m|c|re)alloc\w*\s*\(/gi,
  /\b\w+_strn?dup\w*\s*\(/gi,
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
function namePatterns(names: string[] | undefined, envVar: string): RegExp[] {
  const list = names?.length ? names : (process.env[envVar] || '').split(',');
  return list
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_]\w*$/.test(s))
    .map((n) => new RegExp(`\\b${n}\\s*\\(`, 'g'));
}

@Injectable()
export class CandidateScanService {
  scan(filePath: string, content?: string, extraAllocators?: string[], extraDeallocators?: string[]) {
    const allocPatterns = [...ALLOC_PATTERNS, ...namePatterns(extraAllocators, 'EXTRA_ALLOCATOR_NAMES')];
    const freePatterns = [...FREE_PATTERNS, ...namePatterns(extraDeallocators, 'EXTRA_DEALLOCATOR_NAMES')];
    const source = content || readFileSync(filePath, 'utf-8');
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
          const funcName = this.extractFunctionName(lines, i);
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

  private extractFunctionName(lines: string[], lineIndex: number): string {
    const funcPattern = /^(?:static\s+)?\w+(?:\s*\*)?\s*(\w+)\s*\(/;
    for (let i = lineIndex; i >= Math.max(0, lineIndex - 20); i--) {
      const match = funcPattern.exec(lines[i]);
      if (match) return match[1];
    }
    return 'unknown';
  }
}
