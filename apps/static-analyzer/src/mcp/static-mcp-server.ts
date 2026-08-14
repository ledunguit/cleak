import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok } from '@cleak/common/mcp/ok-helper';
import { STATIC_TOOL_DEFS } from '@cleak/common/mcp/tool-catalog';
import { instrumentTool, type Logger } from '@cleak/observability';
import type {
  RepoIndexResponse,
  CandidateScanResponse,
  AstScanResponse,
  CallGraphResponse,
  FunctionSummaryResponse,
  InterproceduralFlowResponse,
  PathConstraintsResponse,
  OwnershipSummaryResponse,
  OwnershipConventionsResponse,
  ScanBuildRunResponse,
  ScanBuildReportResponse,
} from '../types/mcp-responses';

/**
 * The static-analyzer's analysis services, resolved from the Nest DI container.
 * The MCP tools below delegate to the SAME service methods the gRPC controller
 * calls (static-analyzer.controller.ts), so both transports are behavior-identical.
 * Unlike gRPC, MCP returns the full JSON result (no proto field stripping).
 */
export interface StaticToolServices {
  fileIndexing: { indexFiles(rootPath: string, fileLimit?: number, excludePatterns?: string[]): RepoIndexResponse };
  candidateScan: { scan(filePath: string, content: string, extraAllocators?: string[], extraDeallocators?: string[]): Promise<CandidateScanResponse> };
  astScan: { parse(filePath: string, content?: string): Promise<AstScanResponse> };
  callGraph: { extract(rootPath: string, files: string[], extraAllocators?: string[], extraDeallocators?: string[]): Promise<CallGraphResponse> };
  functionSummary: { summarize(filePath: string, content: string, functionName: string, extraAllocators?: string[], extraDeallocators?: string[]): Promise<FunctionSummaryResponse> };
  interproceduralFlow: { analyze(rootPath: string, functionName: string, files: string[], extraAllocators?: string[], extraDeallocators?: string[]): Promise<InterproceduralFlowResponse> };
  pathConstraints: { analyze(filePath: string, content: string, lineNumber: number, extraAllocators?: string[], extraDeallocators?: string[]): Promise<PathConstraintsResponse> };
  ownership: { summarize(files: string[], rootPath: string): Promise<OwnershipSummaryResponse>; conventions(content: string, filePath: string): Promise<OwnershipConventionsResponse> };
  scanBuild: { run(projectPath: string, buildCommand: string, timeoutSec?: number): Promise<ScanBuildRunResponse>; getReport(runId: string): Promise<ScanBuildReportResponse> };
}

/** Build the static-analyzer MCP server with all 11 memory-leak analysis tools.
 * Tool names, descriptions and input schemas come from the shared catalog
 * (`@cleak/common/mcp/tool-catalog`) — the single source of truth. Every handler
 * is wrapped with `instrumentTool` so each tool call logs its own
 * started/finished/failed lifecycle (name, redacted args, duration, outcome) —
 * see `@cleak/observability`. */
export function createStaticMcpServer(svc: StaticToolServices, logger: Logger): McpServer {
  const server = new McpServer({ name: 'static-analyzer', version: '1.0.0' });
  const wrap = <A extends Record<string, unknown>, R>(name: string, handler: (a: A) => Promise<R>) =>
    instrumentTool(logger, name, 'static-analyzer', handler);

  server.registerTool(
    STATIC_TOOL_DEFS.indexFiles.name,
    { description: STATIC_TOOL_DEFS.indexFiles.description, inputSchema: STATIC_TOOL_DEFS.indexFiles.inputSchema },
    wrap(STATIC_TOOL_DEFS.indexFiles.name, async (a) => ok(await svc.fileIndexing.indexFiles(a.rootPath, a.fileLimit, a.excludePatterns))),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.candidateScan.name,
    {
      description: STATIC_TOOL_DEFS.candidateScan.description,
      inputSchema: STATIC_TOOL_DEFS.candidateScan.inputSchema,
    },
    wrap(STATIC_TOOL_DEFS.candidateScan.name, async (a) => ok(await svc.candidateScan.scan(a.filePath, a.content ?? '', a.extraAllocators, a.extraDeallocators))),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.astScan.name,
    { description: STATIC_TOOL_DEFS.astScan.description, inputSchema: STATIC_TOOL_DEFS.astScan.inputSchema },
    wrap(STATIC_TOOL_DEFS.astScan.name, async (a) => ok(await svc.astScan.parse(a.filePath, a.content ?? ''))),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.callGraph.name,
    { description: STATIC_TOOL_DEFS.callGraph.description, inputSchema: STATIC_TOOL_DEFS.callGraph.inputSchema },
    wrap(STATIC_TOOL_DEFS.callGraph.name, async (a) => ok(await svc.callGraph.extract(a.rootPath, a.files, a.extraAllocators, a.extraDeallocators))),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.functionSummary.name,
    { description: STATIC_TOOL_DEFS.functionSummary.description, inputSchema: STATIC_TOOL_DEFS.functionSummary.inputSchema },
    wrap(STATIC_TOOL_DEFS.functionSummary.name, async (a) =>
      ok(await svc.functionSummary.summarize(a.filePath, a.content ?? '', a.functionName, a.extraAllocators, a.extraDeallocators)),
    ),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.interproceduralFlow.name,
    {
      description: STATIC_TOOL_DEFS.interproceduralFlow.description,
      inputSchema: STATIC_TOOL_DEFS.interproceduralFlow.inputSchema,
    },
    wrap(STATIC_TOOL_DEFS.interproceduralFlow.name, async (a) =>
      ok(await svc.interproceduralFlow.analyze(a.rootPath, a.functionName, a.files, a.extraAllocators, a.extraDeallocators)),
    ),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.pathConstraints.name,
    { description: STATIC_TOOL_DEFS.pathConstraints.description, inputSchema: STATIC_TOOL_DEFS.pathConstraints.inputSchema },
    wrap(STATIC_TOOL_DEFS.pathConstraints.name, async (a) =>
      ok(await svc.pathConstraints.analyze(a.filePath, a.content ?? '', a.lineNumber, a.extraAllocators, a.extraDeallocators)),
    ),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.ownershipSummary.name,
    { description: STATIC_TOOL_DEFS.ownershipSummary.description, inputSchema: STATIC_TOOL_DEFS.ownershipSummary.inputSchema },
    wrap(STATIC_TOOL_DEFS.ownershipSummary.name, async (a) => ok(await svc.ownership.summarize(a.files, a.rootPath))),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.ownershipConventions.name,
    { description: STATIC_TOOL_DEFS.ownershipConventions.description, inputSchema: STATIC_TOOL_DEFS.ownershipConventions.inputSchema },
    wrap(STATIC_TOOL_DEFS.ownershipConventions.name, async (a) => ok(await svc.ownership.conventions(a.content ?? '', a.filePath))),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.scanBuildRun.name,
    { description: STATIC_TOOL_DEFS.scanBuildRun.description, inputSchema: STATIC_TOOL_DEFS.scanBuildRun.inputSchema },
    wrap(STATIC_TOOL_DEFS.scanBuildRun.name, async (a) => ok(await svc.scanBuild.run(a.projectPath, a.buildCommand, a.timeoutSec))),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.scanBuildGetReport.name,
    { description: STATIC_TOOL_DEFS.scanBuildGetReport.description, inputSchema: STATIC_TOOL_DEFS.scanBuildGetReport.inputSchema },
    wrap(STATIC_TOOL_DEFS.scanBuildGetReport.name, async (a) => ok(await svc.scanBuild.getReport(a.runId))),
  );

  return server;
}
