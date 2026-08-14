import type { Logger } from 'pino';
import { ServerEventName } from '@cleak/common/mcp/server-events';
import { withMergedContext } from '@cleak/common/mcp/request-context';
import { previewArgs, summarizeResult } from './redact';

export type AnalyzerLabel = 'static-analyzer' | 'dynamic-analyzer';

/**
 * Wraps one MCP `registerTool` handler so every one of the 21 tools across both
 * servers gets uniform "which MCP tool is running" logging in one shot: a
 * `mcp_tool_started` line (redacted args), `tool` set into the request context
 * for the duration of the call (so every service-level log made deeper in the
 * call chain automatically inherits it via the pino `mixin`), and a
 * `mcp_tool_finished`/`mcp_tool_failed` line with `durationMs` + outcome.
 *
 * Usage: `server.registerTool(NAME, def, instrumentTool(logger, NAME, label, async (a) => ok(...)))`.
 */
export function instrumentTool<A extends Record<string, unknown>, R>(
  logger: Logger,
  toolName: string,
  label: AnalyzerLabel,
  handler: (a: A) => Promise<R>,
): (a: A) => Promise<R> {
  // `label` is intentionally unused in the logged payload below — it's already
  // a static `base` binding on the root logger (one process = one analyzer), so
  // re-logging it per line here would just duplicate the key. Kept as a required
  // parameter anyway: it documents which server this wrapper is for at the call
  // site (`static-mcp-server.ts` vs `dynamic-mcp-server.ts`) and is available for
  // any future per-line use without an API change.
  return (a: A) =>
    withMergedContext({ tool: toolName }, async () => {
      const startedAt = Date.now();
      logger.info({ event: ServerEventName.MCP_TOOL_STARTED, ...previewArgs(a) }, `tool started: ${toolName}`);
      try {
        const result = await handler(a);
        logger.info(
          { event: ServerEventName.MCP_TOOL_FINISHED, durationMs: Date.now() - startedAt, outcome: 'ok', ...summarizeResult(result) },
          `tool finished: ${toolName}`,
        );
        return result;
      } catch (err) {
        logger.error(
          {
            event: ServerEventName.MCP_TOOL_FAILED,
            durationMs: Date.now() - startedAt,
            outcome: 'error',
            err: err instanceof Error ? err.message : String(err),
          },
          `tool failed: ${toolName}`,
        );
        throw err;
      }
    });
}
