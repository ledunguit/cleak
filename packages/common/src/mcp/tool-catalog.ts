/**
 * SINGLE source of truth for the analyzer MCP tool catalog.
 *
 * Every MCP tool the analyzers expose — name, LLM-facing description and Zod
 * input schema — is declared here exactly once. The analyzer MCP servers
 * (`static-mcp-server.ts` / `dynamic-mcp-server.ts`) register their tools FROM
 * these defs, and the orchestrator (`apps/leak-inspector-tui`) derives its tool
 * name sets from the same source, so there is no drift between what a server
 * advertises and what the TUI plans against.
 *
 * Import via the subpath: `@cleak/common/mcp/tool-catalog` (same pattern as
 * `@cleak/common/mcp/ok-helper`).
 */

import { z } from 'zod';

/** A single analyzer MCP tool's contract: name + description + Zod input shape. */
export interface McpToolDefinition {
  /** MCP tool name — the string the orchestrator calls over MCP. */
  name: string;
  /** Tool description advertised to the LLM (what the sub-agent sees in tools/list). */
  description: string;
  /** Zod input schema shape — the tool's parameter contract. */
  inputSchema: z.ZodRawShape;
}

/**
 * Static-analyzer MCP tools (11). The static server registers these verbatim;
 * the TUI derives `STATIC_TOOL_NAMES` from this record.
 */
export const STATIC_TOOL_DEFS = {
  indexFiles: {
    name: 'indexFiles',
    description: 'Index all C/C++ source files recursively from a root path',
    inputSchema: {
      rootPath: z.string(),
      fileLimit: z.number().optional(),
      excludePatterns: z.array(z.string()).optional(),
    },
  },
  candidateScan: {
    name: 'candidateScan',
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
  astScan: {
    name: 'astScan',
    description: 'AST-based structural analysis for memory leak patterns',
    inputSchema: {
      filePath: z.string(),
      content: z.string().optional(),
    },
  },
  callGraph: {
    name: 'callGraph',
    description:
      "Extract call graph edges and nodes, plus cross-function/cross-file ownership correlations (a caller's heap allocation passed into a callee parameter — freed there, or never freed on any path). " +
      'Optionally supply per-project allocators/deallocators so the alloc→free reachability chains track factory allocators.',
    inputSchema: {
      rootPath: z.string(),
      files: z.array(z.string()),
      extraAllocators: z.array(z.string()).optional(),
      extraDeallocators: z.array(z.string()).optional(),
    },
  },
  functionSummary: {
    name: 'functionSummary',
    description:
      'Summarize a function: alloc/free balance, local vars, calls. Optionally supply per-project allocators/deallocators so factory-allocated vars are paired.',
    inputSchema: {
      filePath: z.string(),
      content: z.string().optional(),
      functionName: z.string(),
      extraAllocators: z.array(z.string()).optional(),
      extraDeallocators: z.array(z.string()).optional(),
    },
  },
  interproceduralFlow: {
    name: 'interproceduralFlow',
    description:
      'Interprocedural alloc/free flow tracing for a function. Optionally supply per-project allocators/deallocators so the trace tracks factory allocators (cJSON_malloc/_TIFFfree/…) — without them it is blind to non-libc memory APIs.',
    inputSchema: {
      rootPath: z.string(),
      functionName: z.string(),
      files: z.array(z.string()),
      extraAllocators: z.array(z.string()).optional(),
      extraDeallocators: z.array(z.string()).optional(),
    },
  },
  pathConstraints: {
    name: 'pathConstraints',
    description:
      'Analyze path constraints and feasible paths around an allocation. Optionally supply per-project allocators/deallocators so factory allocations are tracked on exit paths.',
    inputSchema: {
      filePath: z.string(),
      content: z.string().optional(),
      lineNumber: z.number(),
      extraAllocators: z.array(z.string()).optional(),
      extraDeallocators: z.array(z.string()).optional(),
    },
  },
  ownershipSummary: {
    name: 'ownershipSummary',
    description: 'Summarize ownership conventions across files',
    inputSchema: {
      files: z.array(z.string()),
      rootPath: z.string(),
    },
  },
  ownershipConventions: {
    name: 'ownershipConventions',
    description: 'Detect ownership-transfer conventions in a file',
    inputSchema: {
      content: z.string().optional(),
      filePath: z.string(),
    },
  },
  scanBuildRun: {
    name: 'scanBuildRun',
    description: 'Run the project-level Clang Static Analyzer (scan-build) over the project build',
    inputSchema: {
      projectPath: z.string(),
      buildCommand: z.string(),
      timeoutSec: z.number().optional(),
    },
  },
  scanBuildGetReport: {
    name: 'scanBuildGetReport',
    description: 'Retrieve Clang Static Analyzer (scan-build) findings',
    inputSchema: {
      runId: z.string(),
    },
  },
} satisfies Record<string, McpToolDefinition>;

/**
 * Dynamic-analyzer MCP tools (11). The dynamic server registers these verbatim;
 * the TUI derives `DYNAMIC_TOOL_NAMES` from this record.
 */
export const DYNAMIC_TOOL_DEFS = {
  buildTarget: {
    name: 'buildTarget',
    description: 'Build the project with sanitizer-instrumented compiler flags',
    inputSchema: {
      projectPath: z.string(),
      buildCommand: z.string(),
      timeoutSec: z.number().optional(),
    },
  },
  valgrindMemcheck: {
    name: 'valgrindMemcheck',
    description: 'Run Valgrind Memcheck for detailed leak analysis',
    inputSchema: {
      binaryPath: z.string(),
      args: z.array(z.string()).optional(),
      runId: z.string().optional(),
      timeoutSec: z.number().optional(),
    },
  },
  valgrindGetReport: {
    name: 'valgrindGetReport',
    description: 'Retrieve a normalized Valgrind report',
    inputSchema: {
      runId: z.string(),
    },
  },
  valgrindListFindings: {
    name: 'valgrindListFindings',
    description: 'Query Valgrind findings with optional filters',
    inputSchema: {
      runId: z.string(),
      severity: z.string().optional(),
      functionName: z.string().optional(),
    },
  },
  valgrindCompareRuns: {
    name: 'valgrindCompareRuns',
    description: 'Compare two Valgrind analysis runs',
    inputSchema: {
      runIdA: z.string(),
      runIdB: z.string(),
    },
  },
  asanRun: {
    name: 'asanRun',
    description: 'Run the binary under AddressSanitizer for leak detection',
    inputSchema: {
      binaryPath: z.string(),
      args: z.array(z.string()).optional(),
      timeoutSec: z.number().optional(),
    },
  },
  lsanRun: {
    name: 'lsanRun',
    description: 'Run the binary under LeakSanitizer',
    inputSchema: {
      binaryPath: z.string(),
      args: z.array(z.string()).optional(),
      timeoutSec: z.number().optional(),
    },
  },
  runBinary: {
    name: 'runBinary',
    description: 'Run a binary without instrumentation',
    inputSchema: {
      binaryPath: z.string(),
      args: z.array(z.string()).optional(),
      timeoutSec: z.number().optional(),
    },
  },
  buildHarness: {
    name: 'buildHarness',
    description:
      "Compile+link a TARGETED harness (a driver calling one suspicious function/call-chain) against the real project's " +
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
  libfuzzerRun: {
    name: 'libfuzzerRun',
    description:
      'Run a harness binary built with buildHarness(entryStyle="fuzzer") for a short BOUNDED time budget (seconds), ' +
      'exploring inputs instead of one fixed value. Use only after a single-shot run on the same harness came back clean.',
    inputSchema: {
      binaryPath: z.string(),
      maxTotalTimeSec: z.number(),
      timeoutSec: z.number().optional(),
    },
  },
  listRuns: {
    name: 'listRuns',
    description: 'List stored dynamic analysis runs',
    inputSchema: {
      tool: z.string().optional(),
      limit: z.number().optional(),
    },
  },
} satisfies Record<string, McpToolDefinition>;

// Deterministic tool order matters beyond readability: it's what the MCP spec itself
// recommends for prompt-cache-friendliness (a stable tool-schema prefix), and `Object.values`
// over a plain object literal is guaranteed insertion-order for string keys — verified during
// this session's agentic-loop audit as already correct, not something that needed fixing.

/** Every static-analyzer tool name, in registration order. */
export const STATIC_TOOL_NAMES: readonly string[] = Object.values(STATIC_TOOL_DEFS).map((d) => d.name);

/** Every static-analyzer tool def, in registration order. */
export const STATIC_TOOLS: readonly McpToolDefinition[] = Object.values(STATIC_TOOL_DEFS);

/** Every dynamic-analyzer tool name, in registration order. */
export const DYNAMIC_TOOL_NAMES: readonly string[] = Object.values(DYNAMIC_TOOL_DEFS).map((d) => d.name);

/** Every dynamic-analyzer tool def, in registration order. */
export const DYNAMIC_TOOLS: readonly McpToolDefinition[] = Object.values(DYNAMIC_TOOL_DEFS);

/**
 * Static-analyzer tools that accept file CONTENT (so the orchestrator can pass
 * host file content instead of relying on a shared filesystem). These are the
 * only static tools exposed to the agent — the multi-file / filesystem tools
 * (indexFiles, callGraph, interproceduralFlow, ownershipSummary, scanBuild*)
 * need a shared mount and are excluded so the analyzer stays a stateless,
 * remote-deployable service.
 */
export const CONTENT_CAPABLE_TOOLS: ReadonlySet<string> = new Set([
  'candidateScan',
  'astScan',
  'functionSummary',
  'pathConstraints',
  'ownershipConventions',
]);
