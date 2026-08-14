export { createRootLogger } from './logger-factory';
export type { RootLoggerOptions, LogFormat } from './logger-factory';
// Re-exported so consumers (the two analyzer apps) never need a direct `pino`
// dependency just to type a `logger: Logger` parameter.
export type { Logger } from 'pino';
// Re-exported for convenience so a consumer of @cleak/observability doesn't also
// need a direct @cleak/common import just to call runWithContext in main.ts/mcp-http.ts.
export { runWithContext, getContext, withMergedContext } from '@cleak/common/mcp/request-context';
export type { RequestContext } from '@cleak/common/mcp/request-context';
export { PinoNestLogger } from './nest-logger-adapter';
export { instrumentTool } from './tool-instrumentation';
export type { AnalyzerLabel } from './tool-instrumentation';
export { previewArgs, summarizeResult, describeMcpCall } from './redact';
