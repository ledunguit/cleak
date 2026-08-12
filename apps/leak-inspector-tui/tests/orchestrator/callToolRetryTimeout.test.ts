import { describe, expect, test, vi } from 'vitest';
import { callToolRetryTimeout } from '../../src/orchestrator/scanController';

describe('callToolRetryTimeout — bounded retry ONLY for MCP tool-level timeouts', () => {
  test('a timeout error (-32001) is retried once and succeeds on the second attempt', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error('MCP tool functionSummary failed: MCP error -32001: Request timed out'))
      .mockResolvedValueOnce({ ok: true });
    const result = await callToolRetryTimeout('functionSummary', call);
    expect(result).toEqual({ ok: true });
    expect(call).toHaveBeenCalledTimes(2);
  });

  test('a timeout error that fails TWICE propagates (only one retry, not a loop)', async () => {
    const call = vi.fn().mockRejectedValue(new Error('MCP error -32001: Request timed out'));
    await expect(callToolRetryTimeout('pathConstraints', call)).rejects.toThrow(/timed out/);
    expect(call).toHaveBeenCalledTimes(2);
  });

  test('a NON-timeout tool error is NOT retried (stays a real signal, not masked)', async () => {
    const call = vi.fn().mockRejectedValue(new Error('MCP tool functionSummary failed: invalid input: functionName is required'));
    await expect(callToolRetryTimeout('functionSummary', call)).rejects.toThrow(/invalid input/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  test('success on the first attempt never retries', async () => {
    const call = vi.fn().mockResolvedValue('done');
    const result = await callToolRetryTimeout('functionSummary', call);
    expect(result).toBe('done');
    expect(call).toHaveBeenCalledTimes(1);
  });
});
