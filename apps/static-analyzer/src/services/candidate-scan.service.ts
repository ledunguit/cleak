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

@Injectable()
export class CandidateScanService {
  scan(filePath: string, content?: string) {
    const source = content || readFileSync(filePath, 'utf-8');
    const sanitized = this.sanitizeSource(source);
    const lines = source.split('\n');
    const sanitizedLines = sanitized.split('\n');
    const candidates: any[] = [];
    let candidateId = 0;

    const allFreeLines: number[] = [];
    for (let i = 0; i < sanitizedLines.length; i++) {
      for (const pattern of FREE_PATTERNS) {
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

      for (const pattern of ALLOC_PATTERNS) {
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
