import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * The static-analyzer's analysis services, resolved from the Nest DI container.
 * The MCP tools below delegate to the SAME service methods the gRPC controller
 * calls (static-analyzer.controller.ts), so both transports are behavior-identical.
 * Unlike gRPC, MCP returns the full JSON result (no proto field stripping).
 */
export interface StaticToolServices {
  fileIndexing: { indexFiles(rootPath: string, fileLimit?: number, excludePatterns?: string[]): any };
  candidateScan: { scan(filePath: string, content: string, extraAllocators?: string[], extraDeallocators?: string[]): any };
  astScan: { parse(filePath: string, content?: string): any };
  callGraph: { extract(rootPath: string, files: string[]): any };
  functionSummary: { summarize(filePath: string, content: string, functionName: string): any };
  interproceduralFlow: { analyze(rootPath: string, functionName: string, files: string[]): any };
  pathConstraints: { analyze(filePath: string, content: string, lineNumber: number): any };
  ownership: { summarize(files: string[], rootPath: string): any; conventions(content: string, filePath: string): any };
  leakguard: { run(projectPath: string, buildCommand: string, timeoutSec?: number): any; getReport(runId: string): any };
}

const ok = (result: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }],
  structuredContent: (result ?? {}) as Record<string, unknown>,
});

/** Build the static-analyzer MCP server with all 11 memory-leak analysis tools. */
export function createStaticMcpServer(svc: StaticToolServices): McpServer {
  const server = new McpServer({ name: 'static-analyzer', version: '1.0.0' });

  server.registerTool(
    'indexFiles',
    { description: 'Index all C/C++ source files recursively from a root path', inputSchema: { rootPath: z.string(), fileLimit: z.number().optional(), excludePatterns: z.array(z.string()).optional() } },
    async (a) => ok(await svc.fileIndexing.indexFiles(a.rootPath, a.fileLimit, a.excludePatterns)),
  );

  server.registerTool(
    'candidateScan',
    {
      description:
        'Scan a file for allocation sites (malloc, calloc, realloc, strdup, new). ' +
        'Optionally supply per-project factory allocators / custom deallocators (≈ LAMeD AllocSource/FreeSink) ' +
        'so wrapper-named allocators (e.g. cJSON_Duplicate) become candidates.',
      inputSchema: {
        filePath: z.string(),
        content: z.string().optional(),
        extraAllocators: z.array(z.string()).optional(),
        extraDeallocators: z.array(z.string()).optional(),
      },
    },
    async (a) => ok(await svc.candidateScan.scan(a.filePath, a.content ?? '', a.extraAllocators, a.extraDeallocators)),
  );

  server.registerTool(
    'astScan',
    { description: 'AST-based structural analysis for memory leak patterns', inputSchema: { filePath: z.string(), content: z.string().optional() } },
    async (a) => ok(await svc.astScan.parse(a.filePath, a.content ?? '')),
  );

  server.registerTool(
    'callGraph',
    { description: 'Extract call graph edges and nodes', inputSchema: { rootPath: z.string(), files: z.array(z.string()) } },
    async (a) => ok(await svc.callGraph.extract(a.rootPath, a.files)),
  );

  server.registerTool(
    'functionSummary',
    { description: 'Summarize a function: alloc/free balance, local vars, calls', inputSchema: { filePath: z.string(), content: z.string().optional(), functionName: z.string() } },
    async (a) => ok(await svc.functionSummary.summarize(a.filePath, a.content ?? '', a.functionName)),
  );

  server.registerTool(
    'interproceduralFlow',
    { description: 'Interprocedural data flow tracing for a function', inputSchema: { rootPath: z.string(), functionName: z.string(), files: z.array(z.string()) } },
    async (a) => ok(await svc.interproceduralFlow.analyze(a.rootPath, a.functionName, a.files)),
  );

  server.registerTool(
    'pathConstraints',
    { description: 'Analyze path constraints and feasible paths around an allocation', inputSchema: { filePath: z.string(), content: z.string().optional(), lineNumber: z.number() } },
    async (a) => ok(await svc.pathConstraints.analyze(a.filePath, a.content ?? '', a.lineNumber)),
  );

  server.registerTool(
    'ownershipSummary',
    { description: 'Summarize ownership conventions across files', inputSchema: { files: z.array(z.string()), rootPath: z.string() } },
    async (a) => ok(await svc.ownership.summarize(a.files, a.rootPath)),
  );

  server.registerTool(
    'ownershipConventions',
    { description: 'Detect ownership-transfer conventions in a file', inputSchema: { content: z.string().optional(), filePath: z.string() } },
    async (a) => ok(await svc.ownership.conventions(a.content ?? '', a.filePath)),
  );

  server.registerTool(
    'leakguardRun',
    { description: 'Run the project-level Clang Static Analyzer (scan-build) over the project build', inputSchema: { projectPath: z.string(), buildCommand: z.string(), timeoutSec: z.number().optional() } },
    async (a) => ok(await svc.leakguard.run(a.projectPath, a.buildCommand, a.timeoutSec)),
  );

  server.registerTool(
    'leakguardGetReport',
    { description: 'Retrieve Clang Static Analyzer (scan-build) findings', inputSchema: { runId: z.string() } },
    async (a) => ok(await svc.leakguard.getReport(a.runId)),
  );

  return server;
}
