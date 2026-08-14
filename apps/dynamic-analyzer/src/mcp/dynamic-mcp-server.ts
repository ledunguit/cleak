import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok } from '@cleak/common/mcp/ok-helper';
import { DYNAMIC_TOOL_DEFS } from '@cleak/common/mcp/tool-catalog';
import { instrumentTool, type Logger } from '@cleak/observability';
import type {
  BuildTargetResponse,
  ValgrindMemcheckResponse,
  ValgrindGetReportResponse,
  ValgrindListFindingsResponse,
  ValgrindCompareRunsResponse,
  AsanRunResponse,
  LsanRunResponse,
  RunBinaryResponse,
  ListRunsResponse,
  HarnessBuildResponse,
  LibfuzzerRunResponse,
} from '../types/mcp-responses';

/**
 * The dynamic-analyzer's services, resolved from the Nest DI container. MCP
 * tools delegate to the SAME service methods the gRPC controller calls
 * (dynamic-analyzer.controller.ts), so both transports are behavior-identical.
 */
export interface DynamicToolServices {
  buildTarget: { build(projectPath: string, buildCommand: string, timeoutSec?: number): Promise<BuildTargetResponse> };
  valgrind: {
    runMemcheck(binaryPath: string, args: string[], runId?: string, timeoutSec?: number): Promise<ValgrindMemcheckResponse>;
    getReport(runId: string): Promise<ValgrindGetReportResponse>;
    listFindings(runId: string, severity?: string, functionName?: string): Promise<ValgrindListFindingsResponse>;
  };
  asan: { run(binaryPath: string, args: string[], timeoutSec?: number): Promise<AsanRunResponse> };
  lsan: { run(binaryPath: string, args: string[], timeoutSec?: number): Promise<LsanRunResponse> };
  binaryRunner: { run(binaryPath: string, args: string[], timeoutSec?: number): Promise<RunBinaryResponse> };
  compare: { compareValgrindRuns(runIdA: string, runIdB: string): Promise<ValgrindCompareRunsResponse> };
  runManager: { listRuns(tool?: string, limit?: number): Promise<ListRunsResponse> };
  harnessBuild: {
    build(input: {
      projectPath: string;
      buildCommand: string;
      harnessSource: string;
      targetFile: string;
      closureFiles?: string[];
      entryStyle: 'single' | 'fuzzer';
      timeoutSec?: number;
    }): Promise<HarnessBuildResponse>;
  };
  libfuzzerRun: { run(binaryPath: string, maxTotalTimeSec: number, timeoutSec?: number): Promise<LibfuzzerRunResponse> };
}

/** Build the dynamic-analyzer MCP server exposing build + sanitizer tools.
 * Tool names, descriptions and input schemas come from the shared catalog
 * (`@cleak/common/mcp/tool-catalog`) — the single source of truth. Every handler
 * is wrapped with `instrumentTool` so each tool call logs its own
 * started/finished/failed lifecycle (name, redacted args, duration, outcome) —
 * see `@cleak/observability`. */
export function createDynamicMcpServer(svc: DynamicToolServices, logger: Logger): McpServer {
  const server = new McpServer({ name: 'dynamic-analyzer', version: '1.0.0' });
  const wrap = <A extends Record<string, unknown>, R>(name: string, handler: (a: A) => Promise<R>) =>
    instrumentTool(logger, name, 'dynamic-analyzer', handler);

  server.registerTool(
    DYNAMIC_TOOL_DEFS.buildTarget.name,
    { description: DYNAMIC_TOOL_DEFS.buildTarget.description, inputSchema: DYNAMIC_TOOL_DEFS.buildTarget.inputSchema },
    wrap(DYNAMIC_TOOL_DEFS.buildTarget.name, async (a) => ok(await svc.buildTarget.build(a.projectPath, a.buildCommand, a.timeoutSec))),
  );

  server.registerTool(
    DYNAMIC_TOOL_DEFS.valgrindMemcheck.name,
    { description: DYNAMIC_TOOL_DEFS.valgrindMemcheck.description, inputSchema: DYNAMIC_TOOL_DEFS.valgrindMemcheck.inputSchema },
    wrap(DYNAMIC_TOOL_DEFS.valgrindMemcheck.name, async (a) => ok(await svc.valgrind.runMemcheck(a.binaryPath, a.args ?? [], a.runId, a.timeoutSec))),
  );

  server.registerTool(
    DYNAMIC_TOOL_DEFS.valgrindGetReport.name,
    { description: DYNAMIC_TOOL_DEFS.valgrindGetReport.description, inputSchema: DYNAMIC_TOOL_DEFS.valgrindGetReport.inputSchema },
    wrap(DYNAMIC_TOOL_DEFS.valgrindGetReport.name, async (a) => ok(await svc.valgrind.getReport(a.runId))),
  );

  server.registerTool(
    DYNAMIC_TOOL_DEFS.valgrindListFindings.name,
    { description: DYNAMIC_TOOL_DEFS.valgrindListFindings.description, inputSchema: DYNAMIC_TOOL_DEFS.valgrindListFindings.inputSchema },
    wrap(DYNAMIC_TOOL_DEFS.valgrindListFindings.name, async (a) => ok(await svc.valgrind.listFindings(a.runId, a.severity, a.functionName))),
  );

  server.registerTool(
    DYNAMIC_TOOL_DEFS.valgrindCompareRuns.name,
    { description: DYNAMIC_TOOL_DEFS.valgrindCompareRuns.description, inputSchema: DYNAMIC_TOOL_DEFS.valgrindCompareRuns.inputSchema },
    wrap(DYNAMIC_TOOL_DEFS.valgrindCompareRuns.name, async (a) => ok(await svc.compare.compareValgrindRuns(a.runIdA, a.runIdB))),
  );

  server.registerTool(
    DYNAMIC_TOOL_DEFS.asanRun.name,
    { description: DYNAMIC_TOOL_DEFS.asanRun.description, inputSchema: DYNAMIC_TOOL_DEFS.asanRun.inputSchema },
    wrap(DYNAMIC_TOOL_DEFS.asanRun.name, async (a) => ok(await svc.asan.run(a.binaryPath, a.args ?? [], a.timeoutSec))),
  );

  server.registerTool(
    DYNAMIC_TOOL_DEFS.lsanRun.name,
    { description: DYNAMIC_TOOL_DEFS.lsanRun.description, inputSchema: DYNAMIC_TOOL_DEFS.lsanRun.inputSchema },
    wrap(DYNAMIC_TOOL_DEFS.lsanRun.name, async (a) => ok(await svc.lsan.run(a.binaryPath, a.args ?? [], a.timeoutSec))),
  );

  server.registerTool(
    DYNAMIC_TOOL_DEFS.runBinary.name,
    { description: DYNAMIC_TOOL_DEFS.runBinary.description, inputSchema: DYNAMIC_TOOL_DEFS.runBinary.inputSchema },
    wrap(DYNAMIC_TOOL_DEFS.runBinary.name, async (a) => ok(await svc.binaryRunner.run(a.binaryPath, a.args ?? [], a.timeoutSec))),
  );

  server.registerTool(
    DYNAMIC_TOOL_DEFS.buildHarness.name,
    {
      description: DYNAMIC_TOOL_DEFS.buildHarness.description,
      inputSchema: DYNAMIC_TOOL_DEFS.buildHarness.inputSchema,
    },
    wrap(DYNAMIC_TOOL_DEFS.buildHarness.name, async (a) =>
      ok(
        await svc.harnessBuild.build({
          projectPath: a.projectPath,
          buildCommand: a.buildCommand,
          harnessSource: a.harnessSource,
          targetFile: a.targetFile,
          closureFiles: a.closureFiles,
          entryStyle: a.entryStyle,
          timeoutSec: a.timeoutSec,
        }),
      ),
    ),
  );

  server.registerTool(
    DYNAMIC_TOOL_DEFS.libfuzzerRun.name,
    {
      description: DYNAMIC_TOOL_DEFS.libfuzzerRun.description,
      inputSchema: DYNAMIC_TOOL_DEFS.libfuzzerRun.inputSchema,
    },
    wrap(DYNAMIC_TOOL_DEFS.libfuzzerRun.name, async (a) => ok(await svc.libfuzzerRun.run(a.binaryPath, a.maxTotalTimeSec, a.timeoutSec))),
  );

  server.registerTool(
    DYNAMIC_TOOL_DEFS.listRuns.name,
    { description: DYNAMIC_TOOL_DEFS.listRuns.description, inputSchema: DYNAMIC_TOOL_DEFS.listRuns.inputSchema },
    wrap(DYNAMIC_TOOL_DEFS.listRuns.name, async (a) => ok(await svc.runManager.listRuns(a.tool, a.limit))),
  );

  return server;
}
