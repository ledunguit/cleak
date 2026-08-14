import { describe, it, expect, vi } from 'vitest';
import type pino from 'pino';
import { PinoNestLogger } from '../src/nest-logger-adapter.js';

function stubPino() {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
  const rootMethods = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
  const root = { ...rootMethods, child: vi.fn(() => child) } as unknown as pino.Logger;
  return { root, rootMethods, child };
}

describe('PinoNestLogger', () => {
  it('plain-string call: logger.log(message, context) -> info(msg) on a child scoped to context', () => {
    const { root, child } = stubPino();
    new PinoNestLogger(root).log('adapted build command', 'BuildTargetService');
    expect(root.child).toHaveBeenCalledWith({ service: 'BuildTargetService' });
    expect(child.info).toHaveBeenCalledWith('adapted build command');
  });

  it('structured call: logger.log({event, ...}, msg, context) -> info(fields, msg)', () => {
    const { root, child } = stubPino();
    new PinoNestLogger(root).log({ event: 'build_started', projectPath: '/tmp/x' }, 'build started', 'BuildTargetService');
    expect(child.info).toHaveBeenCalledWith({ event: 'build_started', projectPath: '/tmp/x' }, 'build started');
  });

  it('error(message, context): no context leaks into the message text', () => {
    const { root, child } = stubPino();
    new PinoNestLogger(root).error('build FAILED', 'BuildTargetService');
    expect(child.error).toHaveBeenCalledWith('build FAILED');
  });

  it('error(message, stack, context): a trailing stack-trace-shaped string is extracted, not logged as the message', () => {
    const { root, child } = stubPino();
    const stack = 'Error: boom\n    at foo (/a.ts:1:1)';
    new PinoNestLogger(root).error('parse failed', stack, 'AstScanService');
    expect(child.error).toHaveBeenCalledWith({ stack }, 'parse failed');
  });

  it('no context: logs on the root logger, not a child', () => {
    const { root, rootMethods, child } = stubPino();
    new PinoNestLogger(root).warn('no context here');
    expect(root.child).not.toHaveBeenCalled();
    expect(child.warn).not.toHaveBeenCalled();
    expect(rootMethods.warn).toHaveBeenCalledWith('no context here');
  });
});
