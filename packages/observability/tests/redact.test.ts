import { describe, it, expect } from 'vitest';
import { previewArgs, summarizeResult, describeMcpCall } from '../src/redact.js';

describe('previewArgs', () => {
  it('truncates long string values and never echoes full content', () => {
    const content = 'x'.repeat(500);
    const out = previewArgs({ filePath: 'a.c', content });
    expect(out.filePath).toBe('a.c');
    expect(out.content.length).toBeLessThan(content.length);
    expect(out.content).not.toBe(content);
  });

  it('previews arrays as a length marker', () => {
    expect(previewArgs({ files: ['a.c', 'b.c', 'c.c'] }).files).toBe('[3]');
  });

  it('passes through scalars', () => {
    const out = previewArgs({ lineNumber: 42, verbose: true });
    expect(out.lineNumber).toBe('42');
    expect(out.verbose).toBe('true');
  });
});

describe('summarizeResult', () => {
  it('summarizes an array result as a length', () => {
    expect(summarizeResult([1, 2, 3])).toEqual({ resultLength: 3 });
  });

  it('never leaves a long string field unredacted', () => {
    const out = summarizeResult({ report: 'y'.repeat(1000) }) as { report: string };
    expect(out.report.length).toBeLessThan(1000);
  });
});

describe('describeMcpCall', () => {
  it('builds a toolName(args) preview for a tools/call body', () => {
    const label = describeMcpCall({ method: 'tools/call', params: { name: 'candidateScan', arguments: { filePath: 'a.c' } } });
    expect(label).toBe('candidateScan(filePath=a.c)');
  });

  it('falls back to the bare method for non tools/call requests', () => {
    expect(describeMcpCall({ method: 'tools/list' })).toBe('tools/list');
  });

  it('handles a missing/malformed body', () => {
    expect(describeMcpCall(undefined)).toBe('unknown');
  });
});
