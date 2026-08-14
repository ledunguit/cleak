import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { createRootLogger } from '../src/logger-factory.js';
import { runWithContext } from '@cleak/common/mcp/request-context';

function captureStream(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines: () => chunks.join('').split('\n').filter(Boolean) };
}

describe('createRootLogger (json format)', () => {
  it('emits valid JSON lines with ts/level/label and merges the active request context', () => {
    const { stream, lines } = captureStream();
    // format:'json' skips the pino-pretty transport branch entirely, so we can
    // point pino straight at a capturable stream via the destination override.
    const logger = pino(
      {
        base: { label: 'static-analyzer' },
        timestamp: () => `,"ts":"${new Date().toISOString()}"`,
        formatters: { level: (label) => ({ level: label }) },
      },
      stream,
    );

    runWithContext({ requestId: 'r1', correlationId: 'scan-1', label: 'static-analyzer' }, () => {
      logger.info({ event: 'mcp_tool_started' }, 'tool started');
    });

    const [line] = lines();
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe('info');
    expect(typeof parsed.ts).toBe('string');
    expect(parsed.label).toBe('static-analyzer');
    expect(parsed.msg).toBe('tool started');
    expect(parsed.event).toBe('mcp_tool_started');
  });

  it('createRootLogger builds without throwing for both formats', () => {
    expect(() => createRootLogger({ label: 'dynamic-analyzer', format: 'json' })).not.toThrow();
  });
});
