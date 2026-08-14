import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context threaded through every log line via pino's `mixin` hook
 * (see `logger-factory.ts`) instead of being passed as a parameter through
 * every service method. Set once at the top of a request (`mcp-http.ts`) and
 * enriched deeper in the call chain (`tool-instrumentation.ts` adds `tool`).
 */
export interface RequestContext {
  /** Generated fresh per HTTP request (`crypto.randomUUID()`), unique even across retries. */
  requestId: string;
  /** The calling scan's id, threaded from the MCP client's `x-scan-id` header — undefined for ad hoc / non-scan callers. */
  correlationId?: string;
  /** Which analyzer this process is. */
  label: 'static-analyzer' | 'dynamic-analyzer';
  /** The MCP tool currently executing, set by `instrumentTool`. */
  tool?: string;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `ctx` as the active request context for its entire (async) call tree. */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The active request context, or `undefined` outside any `runWithContext` call. */
export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Run `fn` with the current context shallow-merged with `patch` — used to add
 * fields (e.g. `tool`) without dropping `requestId`/`correlationId` already set
 * higher up the call chain. Falls back to `patch` alone if there is no active context.
 */
export function withMergedContext<T>(patch: Partial<RequestContext>, fn: () => T): T {
  const current = getContext();
  return storage.run({ ...(current ?? ({} as RequestContext)), ...patch } as RequestContext, fn);
}
