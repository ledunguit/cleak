import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok } from '@cleak/common/mcp/ok-helper';
import { STATIC_TOOL_DEFS } from '@cleak/common/mcp/tool-catalog';
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
 * (`@cleak/common/mcp/tool-catalog`) — the single source of truth. */
export function createStaticMcpServer(svc: StaticToolServices): McpServer {
  const server = new McpServer({ name: 'static-analyzer', version: '1.0.0' });

  server.registerTool(
    STATIC_TOOL_DEFS.indexFiles.name,
    { description: STATIC_TOOL_DEFS.indexFiles.description, inputSchema: STATIC_TOOL_DEFS.indexFiles.inputSchema },
    async (a) => ok(await svc.fileIndexing.indexFiles(a.rootPath, a.fileLimit, a.excludePatterns)),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.candidateScan.name,
    {
      description: STATIC_TOOL_DEFS.candidateScan.description,
      inputSchema: STATIC_TOOL_DEFS.candidateScan.inputSchema,
    },
    async (a) => ok(await svc.candidateScan.scan(a.filePath, a.content ?? '', a.extraAllocators, a.extraDeallocators)),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.astScan.name,
    { description: STATIC_TOOL_DEFS.astScan.description, inputSchema: STATIC_TOOL_DEFS.astScan.inputSchema },
    async (a) => ok(await svc.astScan.parse(a.filePath, a.content ?? '')),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.callGraph.name,
    { description: STATIC_TOOL_DEFS.callGraph.description, inputSchema: STATIC_TOOL_DEFS.callGraph.inputSchema },
    async (a) => ok(await svc.callGraph.extract(a.rootPath, a.files, a.extraAllocators, a.extraDeallocators)),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.functionSummary.name,
    { description: STATIC_TOOL_DEFS.functionSummary.description, inputSchema: STATIC_TOOL_DEFS.functionSummary.inputSchema },
    async (a) => ok(await svc.functionSummary.summarize(a.filePath, a.content ?? '', a.functionName, a.extraAllocators, a.extraDeallocators)),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.interproceduralFlow.name,
    {
      description: STATIC_TOOL_DEFS.interproceduralFlow.description,
      inputSchema: STATIC_TOOL_DEFS.interproceduralFlow.inputSchema,
    },
    async (a) => ok(await svc.interproceduralFlow.analyze(a.rootPath, a.functionName, a.files, a.extraAllocators, a.extraDeallocators)),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.pathConstraints.name,
    { description: STATIC_TOOL_DEFS.pathConstraints.description, inputSchema: STATIC_TOOL_DEFS.pathConstraints.inputSchema },
    async (a) => ok(await svc.pathConstraints.analyze(a.filePath, a.content ?? '', a.lineNumber, a.extraAllocators, a.extraDeallocators)),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.ownershipSummary.name,
    { description: STATIC_TOOL_DEFS.ownershipSummary.description, inputSchema: STATIC_TOOL_DEFS.ownershipSummary.inputSchema },
    async (a) => ok(await svc.ownership.summarize(a.files, a.rootPath)),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.ownershipConventions.name,
    { description: STATIC_TOOL_DEFS.ownershipConventions.description, inputSchema: STATIC_TOOL_DEFS.ownershipConventions.inputSchema },
    async (a) => ok(await svc.ownership.conventions(a.content ?? '', a.filePath)),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.scanBuildRun.name,
    { description: STATIC_TOOL_DEFS.scanBuildRun.description, inputSchema: STATIC_TOOL_DEFS.scanBuildRun.inputSchema },
    async (a) => ok(await svc.scanBuild.run(a.projectPath, a.buildCommand, a.timeoutSec)),
  );

  server.registerTool(
    STATIC_TOOL_DEFS.scanBuildGetReport.name,
    { description: STATIC_TOOL_DEFS.scanBuildGetReport.description, inputSchema: STATIC_TOOL_DEFS.scanBuildGetReport.inputSchema },
    async (a) => ok(await svc.scanBuild.getReport(a.runId)),
  );

  return server;
}
