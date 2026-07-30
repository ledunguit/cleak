import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok } from '@cleak/common/mcp/ok-helper';
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

const runArgs = { binaryPath: z.string(), args: z.array(z.string()).optional(), timeoutSec: z.number().optional() };

/** Build the dynamic-analyzer MCP server exposing build + sanitizer tools. */
export function createDynamicMcpServer(svc: DynamicToolServices): McpServer {
  const server = new McpServer({ name: 'dynamic-analyzer', version: '1.0.0' });

  server.registerTool(
    'buildTarget',
    { description: 'Build the project with sanitizer-instrumented compiler flags', inputSchema: { projectPath: z.string(), buildCommand: z.string(), timeoutSec: z.number().optional() } },
    async (a) => ok(await svc.buildTarget.build(a.projectPath, a.buildCommand, a.timeoutSec)),
  );

  server.registerTool(
    'valgrindMemcheck',
    { description: 'Run Valgrind Memcheck for detailed leak analysis', inputSchema: { binaryPath: z.string(), args: z.array(z.string()).optional(), runId: z.string().optional(), timeoutSec: z.number().optional() } },
    async (a) => ok(await svc.valgrind.runMemcheck(a.binaryPath, a.args ?? [], a.runId, a.timeoutSec)),
  );

  server.registerTool(
    'valgrindGetReport',
    { description: 'Retrieve a normalized Valgrind report', inputSchema: { runId: z.string() } },
    async (a) => ok(await svc.valgrind.getReport(a.runId)),
  );

  server.registerTool(
    'valgrindListFindings',
    { description: 'Query Valgrind findings with optional filters', inputSchema: { runId: z.string(), severity: z.string().optional(), functionName: z.string().optional() } },
    async (a) => ok(await svc.valgrind.listFindings(a.runId, a.severity, a.functionName)),
  );

  server.registerTool(
    'valgrindCompareRuns',
    { description: 'Compare two Valgrind analysis runs', inputSchema: { runIdA: z.string(), runIdB: z.string() } },
    async (a) => ok(await svc.compare.compareValgrindRuns(a.runIdA, a.runIdB)),
  );

  server.registerTool(
    'asanRun',
    { description: 'Run the binary under AddressSanitizer for leak detection', inputSchema: { ...runArgs } },
    async (a) => ok(await svc.asan.run(a.binaryPath, a.args ?? [], a.timeoutSec)),
  );

  server.registerTool(
    'lsanRun',
    { description: 'Run the binary under LeakSanitizer', inputSchema: { ...runArgs } },
    async (a) => ok(await svc.lsan.run(a.binaryPath, a.args ?? [], a.timeoutSec)),
  );

  server.registerTool(
    'runBinary',
    { description: 'Run a binary without instrumentation', inputSchema: { ...runArgs } },
    async (a) => ok(await svc.binaryRunner.run(a.binaryPath, a.args ?? [], a.timeoutSec)),
  );

  server.registerTool(
    'buildHarness',
    {
      description:
        'Compile+link a TARGETED harness (a driver calling one suspicious function/call-chain) against the real project\'s ' +
        'own compiler flags (recovered via compile_commands.json), instead of building the whole project. For a `static` ' +
        '(internal-linkage) target function, harnessSource MUST #include the defining source file directly and closureFiles ' +
        'MUST NOT also list that file (would duplicate-define it) — for an externally-linked function, harnessSource should ' +
        'extern-declare it and closureFiles should list the file(s) needed to link it. entryStyle="fuzzer" compiles the SAME ' +
        'harness source with -fsanitize=fuzzer,address instead of a plain single-run binary. Returns reason="harness_unresolvable" ' +
        'when the build system could not be captured (unsupported build) — fall back rather than retry.',
      inputSchema: {
        projectPath: z.string(),
        buildCommand: z.string(),
        harnessSource: z.string(),
        targetFile: z.string(),
        closureFiles: z.array(z.string()).optional(),
        entryStyle: z.enum(['single', 'fuzzer']),
        timeoutSec: z.number().optional(),
      },
    },
    async (a) =>
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
  );

  server.registerTool(
    'libfuzzerRun',
    {
      description:
        'Run a harness binary built with buildHarness(entryStyle="fuzzer") for a short BOUNDED time budget (seconds), ' +
        'exploring inputs instead of one fixed value. Use only after a single-shot run on the same harness came back clean.',
      inputSchema: { binaryPath: z.string(), maxTotalTimeSec: z.number(), timeoutSec: z.number().optional() },
    },
    async (a) => ok(await svc.libfuzzerRun.run(a.binaryPath, a.maxTotalTimeSec, a.timeoutSec)),
  );

  server.registerTool(
    'listRuns',
    { description: 'List stored dynamic analysis runs', inputSchema: { tool: z.string().optional(), limit: z.number().optional() } },
    async (a) => ok(await svc.runManager.listRuns(a.tool, a.limit)),
  );

  return server;
}
