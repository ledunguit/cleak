import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import { instrumentTool } from '../src/tool-instrumentation.js';
import { getContext, runWithContext } from '@cleak/common/mcp/request-context';

function stubLogger(): Logger {
  return { info: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('instrumentTool', () => {
  it('logs started then finished, in order, with durationMs and outcome ok', async () => {
    const logger = stubLogger();
    const handler = vi.fn(async (a: { x: number }) => a.x * 2);
    const wrapped = instrumentTool(logger, 'myTool', 'static-analyzer', handler);

    const result = await wrapped({ x: 21 });

    expect(result).toBe(42);
    expect(logger.info).toHaveBeenCalledTimes(2);
    const [startedArgs] = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0];
    const [finishedArgs] = (logger.info as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(startedArgs.event).toBe('mcp_tool_started');
    expect(finishedArgs.event).toBe('mcp_tool_finished');
    expect(finishedArgs.outcome).toBe('ok');
    expect(typeof finishedArgs.durationMs).toBe('number');
  });

  it('logs a failed event and rethrows on error, without swallowing it', async () => {
    const logger = stubLogger();
    const boom = new Error('boom');
    const wrapped = instrumentTool(logger, 'myTool', 'dynamic-analyzer', async () => {
      throw boom;
    });

    await expect(wrapped({})).rejects.toBe(boom);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [errArgs] = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(errArgs.event).toBe('mcp_tool_failed');
    expect(errArgs.outcome).toBe('error');
    expect(errArgs.err).toBe('boom');
  });

  it('sets `tool` in the request context for the duration of the call without dropping requestId', async () => {
    const logger = stubLogger();
    let seenDuringCall: string | undefined;
    const wrapped = instrumentTool(logger, 'candidateScan', 'static-analyzer', async () => {
      seenDuringCall = getContext()?.tool;
      expect(getContext()?.requestId).toBe('req-1');
      return 'ok';
    });

    await runWithContext({ requestId: 'req-1', label: 'static-analyzer' }, () => wrapped({}));
    expect(seenDuringCall).toBe('candidateScan');
  });
});
