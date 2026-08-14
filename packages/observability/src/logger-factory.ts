import pino from 'pino';
import { getContext } from '@cleak/common/mcp/request-context';

export type LogFormat = 'json' | 'pretty';

export interface RootLoggerOptions {
  /** Which analyzer this process is — stamped on every line as `label`. */
  label: 'static-analyzer' | 'dynamic-analyzer';
  /** Minimum level. Defaults to env `LOG_LEVEL`, else `'info'`. */
  level?: string;
  /** Defaults to env `LOG_FORMAT`, else `'pretty'` on a TTY and `'json'` otherwise (always `json` in Docker). */
  format?: LogFormat;
}

function resolveFormat(explicit?: LogFormat): LogFormat {
  const env = process.env.LOG_FORMAT;
  if (explicit) return explicit;
  if (env === 'json' || env === 'pretty') return env;
  return process.stdout.isTTY ? 'pretty' : 'json';
}

/**
 * Build the process-wide root logger. `mixin` is the mechanism that auto-attaches
 * the active request context (`requestId`/`correlationId`/`tool`, set in
 * `mcp-http.ts` / `tool-instrumentation.ts` via `AsyncLocalStorage`) to EVERY log
 * line emitted anywhere downstream — including through the NestJS `Logger` shim
 * (`nest-logger-adapter.ts`) — without threading a context parameter through any
 * service method signature.
 */
export function createRootLogger(opts: RootLoggerOptions): pino.Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? 'info';
  const format = resolveFormat(opts.format);

  return pino({
    level,
    base: { label: opts.label },
    // `ts` (not pino's default `time`) to match the TUI orchestrator's
    // `ScanEvent.ts` field name — one grep-able convention across the system.
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => ({ level: label }),
    },
    // `label` is already a static `base` binding above (this process IS one
    // analyzer) — drop it from the per-line context merge so it doesn't appear
    // twice in every log line even though `RequestContext.label` also carries it
    // (kept there since some contexts, e.g. tests, read it off the context directly).
    mixin: () => {
      const ctx = getContext();
      if (!ctx) return {};
      const { label: _label, ...rest } = ctx;
      return rest;
    },
    ...(format === 'pretty'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: false, ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}
