# MCP Tools Reference

> Comprehensive reference for every tool exposed by the **static-analyzer** and
> **dynamic-analyzer** MCP servers. Covers input schema, handler implementation,
> return type, JSON-RPC examples, and integration with the TUI orchestrator.
>
> Pipeline overview & component topology: [ARCHITECTURE.md](./ARCHITECTURE.md)
> (sections 4–5). Agent prompts that reference these tools:
> [PROMPTS.md](./PROMPTS.md) (sections 1, 5, 10). Runtime sequence diagrams:
> [sequence-diagrams.md](./sequence-diagrams.md).

---

## 1. Shared Infrastructure

Both analyzers share common patterns for transport, execution, persistence, and
parsing. This section documents them once.

### 1.1 MCP Transport

Both servers serve MCP over **Streamable-HTTP** (not stdio).

- **Port:** `50061` for static-analyzer, `50062` for dynamic-analyzer (overridable
  via `MCP_HTTP_PORT` env var).
- **Protocol:** JSON-RPC 2.0 over HTTP POST. Each tool call is a
  `tools/call` request; results are returned as a JSON-RPC response wrapped
  through the `ok()` helper.
- **Boot sequence:** `main.ts` builds a NestJS DI context, resolves service
  singletons, creates the `McpServer` instance, then calls `startMcpHttp()`
  (re-exported from `@cleak/common/mcp/mcp-http`).

The `ok()` helper (`@cleak/common/mcp/ok-helper`) wraps any JSON value into the
standard MCP content envelope:

```typescript
function ok(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data ?? null) }],
    structuredContent: (data ?? {}) as Record<string, unknown>,
  };
}
```

All tool handlers return `ok(resultObject)`. The response the client receives
is always:

```json
{
  "content": [{ "type": "text", "text": "{ ... serialized result ... }" }],
  "structuredContent": { ... }
}
```

The `structuredContent` field mirrors the parsed result object for client-side
consumption without re-parsing the text content.

**Transport details:** Both servers use `StreamableHTTPServerTransport` from
the MCP SDK in **stateless JSON mode** — a fresh `McpServer` + transport is
created per request so concurrent calls cannot collide on JSON-RPC IDs.
The HTTP endpoint is `POST /mcp`. A `/health` endpoint returns
`{ status: 'ok', transport: 'mcp', label }`.

### 1.2 `runConfined()` — Universal Execution Primitive

**File:** `apps/dynamic-analyzer/src/services/safe-exec.ts`

Used by every dynamic-analyzer tool that spawns a binary (build, valgrind, ASan,
LSan, plain run). Properties:

- **No shell injection:** Uses `execFile()` with an argv array, never a command string.
- **Resource confinement (Linux):** Wraps the binary in
  `bash -c 'ulimit -t <cpu> -v <as> -f <fsize> -u <nproc>; exec "$@"'`
  with env-tunable limits (`DYNAMIC_ULIMIT_AS_KB`, `DYNAMIC_ULIMIT_FSIZE_KB`,
  `DYNAMIC_ULIMIT_NPROC`). Can be disabled entirely via `DYNAMIC_ULIMIT=off`.
- **Unlimited address space mode:** For sanitizer runs, the `-v` ulimit is dropped
  (ASan needs ~20 TB virtual for shadow memory; Valgrind needs huge VAS).
- **Kill signal:** Always `SIGKILL` on timeout.
- **Never throws:** Captures all errors (non-zero exit, timeout, signal) into a
  `ConfinedResult { stdout, stderr, code, timedOut }`.

### 1.3 `RunManagerService` — File-Based Run Persistence

**File:** `apps/dynamic-analyzer/src/services/run-manager.service.ts`

Stores every dynamic-analysis run as a JSON file in the `./runs` directory
(overridable via `RUNS_DIR` env var). Methods:

| Method | Description |
|---|---|
| `saveRun(run)` | Serialize a `RunRecord` to `<runs_dir>/<runId>.json` |
| `getRun(runId)` | Deserialize and return the `RunRecord`, or `null` |
| `listRuns(tool?, limit?)` | List `RunSummary[]` sorted by `createdAt` desc (default limit 50) |

### 1.4 `CParserService` — Tree-sitter C/C++ Parser

**File:** `apps/static-analyzer/src/services/c-parser.service.ts`

The core parsing service consumed by every static-analysis tool. Uses
[node-tree-sitter](https://github.com/tree-sitter/node-tree-sitter) with
C and C++ grammars.

- **Content-hash LRU cache:** Caches parsed ASTs by SHA1 hash of file content
  (max 512 entries). Re-parsing the same file across multiple tool calls is a
  cache hit.
- **File vs content modes:** Accepts either a `filePath` (read from disk) or
  inline `content` string. The `content` parameter is how the TUI passes file
  data from its own workspace (avoiding shared-filesystem dependency for the 5
  [CONTENT_CAPABLE_TOOLS](#21-pipeline-integration) exposed to the LLM agent).
- **Symlink safety:** Path resolution in file-indexing uses `lstatSync` +
  `realpathSync` to verify that symlinked targets stay within the project root
  (path-traversal defense).

### 1.5 Execution Policies

**File:** `apps/leak-inspector-tui/src/domain/mcpToolPlan.ts`

The TUI orchestrator classifies every MCP tool into one of two execution
policies, defined as `McpToolFlags`:

| Policy | `readOnly` | `concurrencySafe` | `ask` | `timeoutMs` | Tools |
|---|---|---|---|---|---|
| **CONCURRENCY_SAFE** | `true` | `true` | — | 30 000 | Pure static queries, read-only run listings |
| **SERIAL_HEAVY** | `true` | `false` | `true` | 300 000 | Builds, sanitizers, scan-build |

All tools are `readOnly: true` — neither analyzer writes source code back.

### 1.6 Data Flow

```
LeakCandidate → LeakBundle → VerdictResult → ScanReport
```

- **LeakCandidate:** A raw finding from a single analyzer (e.g., an `astScan`
  pattern, a `valgrindMemcheck` finding).
- **LeakBundle:** Normalized, cross-analyzer merged representation (deduplicated
  by location).
- **VerdictResult:** A final verdict produced by the heuristic judge or LLM judge
  for borderline cases.
- **ScanReport:** The final output artifact (JSON / Markdown / HTML / Snapshot).

---

## 2. Static Analyzer Tools

The static-analyzer (`apps/static-analyzer`, port **50061**) exposes **11 tools**
for C/C++ source analysis. All are backed by `CParserService` for tree-sitter
parsing and return values wrapped through `ok()`.

### 2.1 Pipeline Integration

| Tool | ScanPhase | Execution Policy | Agent-Exposed (`CONTENT_CAPABLE_TOOLS`) |
|---|---|---|---|
| `indexFiles` | DISCOVERY | CONCURRENCY_SAFE | ❌ |
| `candidateScan` | DISCOVERY | CONCURRENCY_SAFE | ✅ |
| `astScan` | INVESTIGATION | CONCURRENCY_SAFE | ✅ |
| `callGraph` | INVESTIGATION | CONCURRENCY_SAFE | ❌ |
| `functionSummary` | INVESTIGATION | CONCURRENCY_SAFE | ✅ |
| `interproceduralFlow` | INVESTIGATION | CONCURRENCY_SAFE | ❌ |
| `pathConstraints` | INVESTIGATION | CONCURRENCY_SAFE | ✅ |
| `ownershipSummary` | INVESTIGATION | CONCURRENCY_SAFE | ❌ |
| `ownershipConventions` | INVESTIGATION | CONCURRENCY_SAFE | ✅ |
| `scanBuildRun` | SCAN_BUILD | SERIAL_HEAVY | ❌ |
| `scanBuildGetReport` | SCAN_BUILD | CONCURRENCY_SAFE | ❌ |

> **Agent-exposed** means the tool is included in `CONTENT_CAPABLE_TOOLS`
> (`mcpToolPlan.ts:103-109`) and visible to the LLM sub-agent during Stage A.
> The 6 non-exposed tools either require a shared filesystem mount
> (`indexFiles`, `callGraph`, `interproceduralFlow`, `ownershipSummary`) or
> are build/report steps driven by deterministic orchestrator code
> (`scanBuildRun`, `scanBuildGetReport`).

---

### `indexFiles`

**Purpose:** Index all C/C++ source files recursively from a root path.

**Input Schema:**
```typescript
{
  rootPath: z.string(),                  // directory to scan
  fileLimit: z.number().optional(),      // max files to collect (default 10 000)
  excludePatterns: z.array(z.string()).optional(),  // globs to skip
}
```

**Handler:** `FileIndexingService.indexFiles()` at
`apps/static-analyzer/src/services/file-indexing.service.ts:7-38`

Walks the directory tree starting from `rootPath`, collecting files with C/C++
extensions (`.c`, `.h`, `.cpp`, `.hpp`, `.cc`, `.cxx`, `.hh`). Uses `lstatSync`
to detect symlinks and only follows a symlink if its real target resolves strictly
inside the canonical `rootPath` (path-injection defense). Skips directories named
`.`, `node_modules`, and `__pycache__`. Stops at `fileLimit`.

**Return Type:**
```typescript
{
  files: string[];       // collected file paths, relative or absolute
  totalCount: number;    // files.length
  errors: string[];      // any read/access errors (e.g., permission denied)
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "indexFiles", "arguments": { "rootPath": "/repo/src", "fileLimit": 5000 } } }

// Response
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "{\"files\":[\"/repo/src/main.c\",\"/repo/src/utils.c\",\"...\"],\"totalCount\":42,\"errors\":[]}" }] } }
```

**Dependencies:** `CParserService` (for extension matching only).

**Error Scenarios:** Non-existent `rootPath` throws (handled by `ok()` error
envelope). Permission-denied directories are skipped and recorded in `errors[]`.

---

### `candidateScan`

**Purpose:** Scan a file for allocation sites (malloc, calloc, realloc, strdup,
new). Optionally supply per-project factory allocators / custom deallocators so
wrapper-named allocators (e.g., `cJSON_Duplicate`) become candidates.

**Input Schema:**
```typescript
{
  filePath: z.string(),                    // file to scan
  content: z.string().optional(),          // inline content (bypasses disk read)
  extraAllocators: z.array(z.string()).optional(),   // project-specific alloc function names
  extraDeallocators: z.array(z.string()).optional(), // project-specific free function names
}
```

**Handler:** `CandidateScanService.scan()` at
`apps/static-analyzer/src/services/candidate-scan.service.ts:90-188

Lexically scans source for allocation and deallocation call sites.

- **Built-in allocator patterns** (regex): `malloc(`, `calloc(`, `realloc(`,
  `strdup(`, `xmalloc(`, `xcalloc(`, `xrealloc(`, `xstrdup(`, `new`,
  `\balloc`, `\w+_alloc`
- **Built-in deallocator patterns:** `free(`, `xfree(`, `delete`, `delete[]`,
  `\w*free(`, `dealloc`, `\w+_delete`
- **Extra names** are merged into the regex lists. They can also be supplied
  via env vars `EXTRA_ALLOCATOR_NAMES` and `EXTRA_DEALLOCATOR_NAMES`.
- Uses `CParserService` to find the enclosing function boundary for each
  candidate (accurate attribution).
- Source is sanitized before scanning: string/char literals and comments are
  stripped while preserving line numbers.
- **Synthetic candidates:** For managed pointer-parameter leaks — a parameter
  the function frees on some paths but loses on others — the service produces
  a synthetic `CandidateEntry` with a parameter-ownership allocation type (no
  actual allocation site exists in the function).

**Return Type:**
```typescript
{
  candidates: CandidateEntry[];
  // CandidateEntry {
  //   id: string;                    // unique within scan
  //   functionName: string;
  //   filePath: string;
  //   lineNumber: number;
  //   allocationSite: string;        // "malloc", "free", "parameter", etc.
  //   allocationType: string;        // "alloc", "free", "parameter_ownership"
  //   confidence: string;            // "high" | "medium" | "low"
  //   context: string;               // surrounding source lines
  //   signature: string;             // enclosing function signature
  //   observedDeallocationCount: number;
  //   earlyReturnLines: number[];
  // }
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "candidateScan", "arguments": { "filePath": "/repo/src/main.c", "extraAllocators": ["cJSON_Duplicate"] } } }

// Response (abridged)
{ "jsonrpc": "2.0", "id": 2, "result": { "content": [{ "type": "text", "text": "{\"candidates\":[{\"id\":\"cand-1\",\"functionName\":\"load_config\",\"allocationSite\":\"malloc\",\"lineNumber\":42,\"allocationType\":\"alloc\",\"confidence\":\"high\",\"context\":\"  int *buf = malloc(size);\\n\",\"signature\":\"int load_config(const char *path)\",\"observedDeallocationCount\":0,\"earlyReturnLines\":[55,60]}]}" }] } }
```

**Dependencies:** `CParserService` (function boundary resolution).

**Error Scenarios:** Missing file returns an error. Empty file returns zero
candidates. Regex false positives are mitigated by the function-boundary check.

---

### `astScan`

**Purpose:** AST-based structural analysis for memory leak patterns.

**Input Schema:**
```typescript
{
  filePath: z.string(),
  content: z.string().optional(),
}
```

**Handler:** `AstScanService.parse()` at
`apps/static-analyzer/src/services/ast-scan.service.ts:48-104

Parses a file with tree-sitter and detects **8 categories** of memory leak
patterns:

1. **Early Return Leak** — allocation before `return` with no `free` on that path
2. **Loop Accumulated Leak** — allocation inside a loop with no `free` in the body
3. **Conditional Leak** — exit path (if/else) that doesn't free all allocations
4. **`strdup` Without Free** — result of `strdup()`/`strndup()` never freed
5. **`realloc` Mishandling** — `realloc()` return not checked, losing original pointer
6. **Missing NULL Check** — allocation result used without NULL guard
7. **Struct Field Allocation Leak** — struct field allocated but never freed
8. **Interprocedural Leak (Exit Path)** — allocation unreconciled across CFG exit paths

Also builds per-function summaries with alloc/free counts, ratio, loop/exit-path
stats, and a confidence score (`high`/`medium`/`low`).

**Return Type:**
```typescript
{
  patterns: MemoryPattern[];                // detected leak patterns
  functionSummaries: FunctionScanSummary[]; // per-function summary stats
}
```

`MemoryPattern` includes `type` (one of the 8 categories), `severity`, `functionName`,
`line`, `description`, and relevant source context. `FunctionScanSummary` includes
`functionName`, `allocCount`, `freeCount`, `ratio`, `loopCount`, `exitPathCount`,
and `confidence`.

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "astScan", "arguments": { "filePath": "/repo/src/main.c" } } }

// Response (abridged)
{ "jsonrpc": "2.0", "id": 3, "result": { "content": [{ "type": "text", "text": "{\"patterns\":[{\"type\":\"early_return_leak\",\"severity\":\"high\",\"functionName\":\"load_config\",\"line\":42,\"description\":\"malloc at line 42 not freed on early return at line 55\"}],\"functionSummaries\":[{\"functionName\":\"load_config\",\"allocCount\":2,\"freeCount\":1,\"ratio\":0.5,\"confidence\":\"medium\"}]}" }] } }
```

**Dependencies:** `CParserService` (tree-sitter parse, CFG exit-path analysis).

---

### `callGraph`

**Purpose:** Extract call graph edges and nodes. Optionally supply per-project
allocators/deallocators so alloc→free reachability chains track factory allocators.

**Input Schema:**
```typescript
{
  rootPath: z.string(),                       // project root (for resolving callee files)
  files: z.array(z.string()),                 // files to analyze
  extraAllocators: z.array(z.string()).optional(),
  extraDeallocators: z.array(z.string()).optional(),
}
```

**Handler:** `CallGraphService.extract()` at
`apps/static-analyzer/src/services/call-graph.service.ts:9-111

Two-pass analysis:

1. **Pass 1:** Parse every file, collect all internal (project-defined) function names.
2. **Pass 2:** Build call edges from each function's `functionCalls` (tree-sitter
   derived), filtering to internal calls only.
3. **Recursion detection:** Direct recursion (self-call) plus indirect recursion
   via DFS with max depth 5.
4. **Alloc-free chain analysis:** For every allocator/free function pair, find
   functions that call both (potential balanced alloc/free sites).

**Return Type:**
```typescript
{
  edges: CallEdge[];                   // { caller, callee, filePath, lineNumber, callee_file }
  nodes: CallGraphNode[];              // { functionName, filePath }
  recursionCycles: string[][];         // arrays of function names forming cycles
  allocFreeChains: AllocFreeChain[];   // { allocFunction, freeFunction, callers[] }
  stats: CallGraphStats;               // totalFunctions, totalEdges, internalEdges,
                                       // externalCalls, recursionCycles
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
  "params": { "name": "callGraph", "arguments": { "rootPath": "/repo", "files": ["/repo/src/main.c", "/repo/src/utils.c"] } } }
```

**Dependencies:** `CParserService` (parse cache across files).

**Error Scenarios:** Large file sets may hit memory limits from caching all
ASTs (mitigated by 512-entry LRU). Recursion detection capped at depth 5.

---

### `functionSummary`

**Purpose:** Summarize a function: alloc/free balance, local vars, calls.
Optionally supply per-project allocators/deallocators.

**Input Schema:**
```typescript
{
  filePath: z.string(),
  content: z.string().optional(),
  functionName: z.string(),                    // function to analyze
  extraAllocators: z.array(z.string()).optional(),
  extraDeallocators: z.array(z.string()).optional(),
}
```

**Handler:** `FunctionSummaryService.summarize()` at
`apps/static-analyzer/src/services/function-summary.service.ts:10-69

Parses the file, filters to the named function, and computes:

- Parameter count, local variable count, call count
- Allocation count, deallocation count, return count
- Leaked variables (allocated but never freed)
- Nonlocal allocations (assigned to variables outside local scope/parameters)
- Exit path counts, loop counts, goto counts
- **`AllocFreePair[]`** — each allocation paired with its matching free (by
  variable name), with status `"paired"`, `"conditional"`, or `"unpaired"`
- **Synthetic pairs** for managed pointer-parameters (function frees on some
  paths but loses on others)

**Return Type:**
```typescript
{
  summary: string;                    // JSON-stringified full function summary
  allocations: string[];              // e.g. ["malloc at line 42"]
  frees: string[];                    // e.g. ["free at line 57"]
  pairs: AllocFreePair[];             // { alloc, free, status }
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 5, "method": "tools/call",
  "params": { "name": "functionSummary", "arguments": { "filePath": "/repo/src/main.c", "functionName": "load_config" } } }
```

**Dependencies:** `CParserService`.

---

### `interproceduralFlow`

**Purpose:** Interprocedural alloc/free flow tracing for a function. Traces how
allocations flow across function call boundaries.

**Input Schema:**
```typescript
{
  rootPath: z.string(),
  functionName: z.string(),                    // start function
  files: z.array(z.string()),                  // files in the project
  extraAllocators: z.array(z.string()).optional(),
  extraDeallocators: z.array(z.string()).optional(),
}
```

**Handler:** `InterproceduralFlowService.analyze()` at
`apps/static-analyzer/src/services/interprocedural-flow.service.ts:58-104

- **Cross-call parse cache:** Keyed by `file::mtime::allocators::deallocators` to
  avoid re-parsing across repeated calls.
- First parses every file once into a function index, then walks the call graph
  over the index.
- For each function in the trace, records: allocs, frees, and whether it has
  allocs without matching frees.
- Captures **free parameters** (pointer params that are freed) and **reachable
  frees** across the entire trace.
- Builds **ownership chains** for each function.
- Computes **variable-level cross-frame reconciliation:** allocations in the
  start function whose variable is freed nowhere reachable — the interprocedural
  leak signal.

**Return Type:**
```typescript
{
  paths: FlowPath[];                  // each function in trace: name, file, lines,
                                      // allocs, frees, hasAllocWithoutFree
  freeParameters: string[];           // pointer params that are freed
  reachableFrees: string[];           // e.g. "free at /repo/src/utils.c:120"
  ownershipChains: OwnershipChain[];  // { function, file, allocCount, freeCount, chain }
  depth: number;                      // number of paths in trace
  hasLeak: boolean;                   // any path hasAllocWithoutFree
  startFunction: string;
  unreconciledAllocVars: string[];    // vars alloc'd at start, freed nowhere reachable
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 6, "method": "tools/call",
  "params": { "name": "interproceduralFlow", "arguments": { "rootPath": "/repo", "functionName": "load_config", "files": ["/repo/src/main.c", "/repo/src/utils.c"] } } }
```

**Dependencies:** `CParserService` (parse cache, function index), `CallGraphService`.

---

### `pathConstraints`

**Purpose:** Analyze path constraints and feasible paths around an allocation,
identifying which control-flow paths could lead to leaks.

**Input Schema:**
```typescript
{
  filePath: z.string(),
  content: z.string().optional(),
  lineNumber: z.number(),                      // line of the allocation site
  extraAllocators: z.array(z.string()).optional(),
  extraDeallocators: z.array(z.string()).optional(),
}
```

**Handler:** `PathConstraintsService.analyze()` at
`apps/static-analyzer/src/services/path-constraints.service.ts:9-63

- Finds the innermost enclosing function for the given `lineNumber` (using
  tree-sitter's `endLine` for accurate boundary detection).
- Extracts all path constraints from conditions in that function.
- Uses CFG exit-path analysis to compute:
  - **Feasible paths** — reachable exit paths through the function
  - **Feasible leak paths** — exit paths that reachably leave an allocation
    un-freed (heuristic-based, **no SMT solver** — the Z3 dependency was removed)
- Returns all exit paths with leak risk, free lines, unreconciled allocations,
  and paths to the target line.

**Return Type:**
```typescript
{
  constraints: string[];                // e.g. "if (ptr == NULL) at line 50"
  feasiblePaths: FeasiblePath[];        // { kind, line, leakRisk, conditions,
                                        //   allocatedNotFreed }
  feasibleLeakPaths?: FeasibleLeakPath[];  // rich leak-path narrative
  exitPaths: ExitPathInfo[];            // { kind, exitLine, hasFreeOnPath,
                                        //   freeLines, leakRisk, ... }
  pathsToTarget?: string[];             // paths reaching the target line
  containsEarlyReturn?: boolean;
  earlyReturnCount?: number;
  totalExitPaths?: number;
  leakyExitPaths?: number;
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 7, "method": "tools/call",
  "params": { "name": "pathConstraints", "arguments": { "filePath": "/repo/src/main.c", "lineNumber": 42 } } }
```

**Dependencies:** `CParserService` (CFG building, condition extraction).

**Known Issues:** Path-feasibility analysis is heuristic (no SMT solver).
False positives are possible on complex conditions with deep boolean nesting.

---

### `ownershipSummary`

**Purpose:** Summarize ownership conventions across files — which functions
return ownership, consume it, or manage it locally.

**Input Schema:**
```typescript
{
  files: z.array(z.string()),
  rootPath: z.string(),
}
```

**Handler:** `OwnershipAnalysisService.summarize()` at
`apps/static-analyzer/src/services/ownership-analysis.service.ts:10-49

Parses each file and analyzes every function for ownership semantics:

- **Inferred ownership type:**
  - `returns_ownership` — allocates and returns without local free
  - `consumes_ownership` — has pointer parameter and frees it
  - `local_ownership` — allocates and frees locally
  - `none` — no ownership semantics detected
- Computes leak risk per function (`high`/`medium`/`low`)
- Builds `OwnershipSummary` with role (`allocator`/`deallocator`/`both`/`neither`),
  ownership carrier (return value or specific parameter), and rationale.

**Return Type:**
```typescript
{
  ownerships: OwnershipEntry[];
  // OwnershipEntry {
  //   functionName: string;
  //   filePath: string;
  //   ownershipType: string;       // returns_ownership | consumes_ownership | local_ownership | none
  //   allocatedObjects: string[];
  //   leakPaths: string[];
  //   leakRisk: string;
  //   summary: OwnershipSummary;   // { role, carrier, rationale }
  // }
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 8, "method": "tools/call",
  "params": { "name": "ownershipSummary", "arguments": { "files": ["/repo/src/main.c"], "rootPath": "/repo" } } }
```

**Dependencies:** `CParserService`.

---

### `ownershipConventions`

**Purpose:** Detect ownership-transfer conventions in a single file.

**Input Schema:**
```typescript
{
  filePath: z.string(),
  content: z.string().optional(),
}
```

**Handler:** `OwnershipAnalysisService.conventions()` at
`apps/static-analyzer/src/services/ownership-analysis.service.ts:122-188

Produces rules for **4 convention types:**

| Convention Type | Description |
|---|---|
| `leak_risk` | Functions that allocate but never free |
| `missing_free` | Allocation variables that are never freed |
| `loop_leak` | Loops that allocate without freeing inside the body |
| `early_return_leak` | Early returns without freeing prior allocations |

Each rule includes a pattern description, detailed explanation, and the
convention type.

**Return Type:**
```typescript
{
  rules: ConventionRule[];
  // ConventionRule {
  //   pattern: string;           // human-readable pattern description
  //   description: string;       // detailed explanation
  //   conventionType: string;    // leak_risk | missing_free | loop_leak | early_return_leak
  // }
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 9, "method": "tools/call",
  "params": { "name": "ownershipConventions", "arguments": { "filePath": "/repo/src/main.c" } } }
```

**Dependencies:** `CParserService`.

---

### `scanBuildRun`

**Purpose:** Run the project-level Clang Static Analyzer (`scan-build`) over the
project build.

**Input Schema:**
```typescript
{
  projectPath: z.string(),         // path to the project root (where buildCommand runs)
  buildCommand: z.string(),        // e.g. "make" or "cmake --build ."
  timeoutSec: z.number().optional(), // default 300
}
```

**Handler:** `ScanBuildAdapterService.run()` at
`apps/static-analyzer/src/services/scan-build-adapter.service.ts:29-51

- Spawns `scan-build` as a child process, passing the build command.
- If the build command contains no shell metacharacters, it is tokenized and
  passed as direct argv (avoiding shell injection); otherwise wrapped in
  `/bin/sh -c`.
- Output directory: `./runs/sb_<timestamp>`.
- Uses `--keep-going` so analysis continues past individual translation unit
  failures.
- The raw output (stderr + stdout) is saved to `./runs/<runId>.scanbuild.json`
  alongside parsed findings.

**Return Type:**
```typescript
{
  success: boolean;       // process exit code === 0
  runId: string;          // "sb_<timestamp>"
  output: string;         // merged stdout + stderr
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 10, "method": "tools/call",
  "params": { "name": "scanBuildRun", "arguments": { "projectPath": "/repo", "buildCommand": "make", "timeoutSec": 600 } } }
```

**Dependencies:** Local `scan-build` binary on PATH (configurable via `SCAN_BUILD_BIN`).

**Error Scenarios:**
- `scan-build` not installed → process fails with non-zero exit code
- Build errors → `success: false` with full stderr in `output`
- Timeout → process is killed and `success` reflects the exit status

---

### `scanBuildGetReport`

**Purpose:** Retrieve Clang Static Analyzer (`scan-build`) findings from a
previous run.

**Input Schema:**
```typescript
{
  runId: z.string(),          // run ID returned by scanBuildRun
}
```

**Handler:** `ScanBuildAdapterService.getReport()` at
`apps/static-analyzer/src/services/scan-build-adapter.service.ts:54-67

Reads the saved scan-build run from `./runs/<runId>.scanbuild.json`. Returns
the raw output text and parsed findings. Findings are extracted from scan-build
stderr by matching `warning:` or `error:` lines against file path patterns
(`file:line:col`). Each finding includes the file path (relative), line number,
extracted function name, confidence (heuristic from line content), and context text.

**Return Type:**
```typescript
{
  report: string;                  // raw scan-build output
  findings: ScanBuildFinding[];    // { id, file_path, line_number, function_name,
                                   //   allocation_type, confidence, context }
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 11, "method": "tools/call",
  "params": { "name": "scanBuildGetReport", "arguments": { "runId": "sb_20260728T120000Z" } } }
```

**Error Scenarios:** Non-existent `runId` returns `{ report: "", findings: [] }`
(with `success: false` in the saved record). Corrupted JSON file returns an error.

---

## 3. Dynamic Analyzer Tools

The dynamic-analyzer (`apps/dynamic-analyzer`, port **50062**) exposes **11 tools**
for binary-level memory analysis. All execution goes through `runConfined()` for
sandboxed, resource-controlled subprocess management.

### 3.1 Pipeline Integration

| Tool | ScanPhase | Execution Policy |
|---|---|---|
| `buildTarget` | DYNAMIC | SERIAL_HEAVY |
| `valgrindMemcheck` | DYNAMIC | SERIAL_HEAVY |
| `valgrindGetReport` | DYNAMIC | CONCURRENCY_SAFE |
| `valgrindListFindings` | DYNAMIC | CONCURRENCY_SAFE |
| `valgrindCompareRuns` | DYNAMIC | CONCURRENCY_SAFE |
| `asanRun` | DYNAMIC | SERIAL_HEAVY |
| `lsanRun` | DYNAMIC | SERIAL_HEAVY |
| `runBinary` | DYNAMIC | SERIAL_HEAVY |
| `buildHarness` | DYNAMIC | SERIAL_HEAVY |
| `libfuzzerRun` | DYNAMIC | SERIAL_HEAVY |
| `listRuns` | DYNAMIC | CONCURRENCY_SAFE |

> All dynamic tools are in ScanPhase `DYNAMIC`. Query tools (getReport,
> listFindings, compareRuns, listRuns) are `CONCURRENCY_SAFE`; build/run tools
> are `SERIAL_HEAVY` because they spawn processes that compete for CPU/memory.
> Most dynamic tools are driven by the deterministic Stage B recipe (`buildTarget`
> → sanitizer runs/`lsanRun`), not the LLM. The exception is Stage B2 (opt-in,
> `workflow.targetedHarness.enabled`): its harness worker sub-agent IS an LLM loop
> that calls `buildHarness`/`lsanRun`/`asanRun` directly to write and run a
> targeted driver — the fuzz-tier escalation (`buildHarness(entryStyle="fuzzer")`
> → `libfuzzerRun`) that may follow is deterministic orchestrator code, not a
> further LLM turn.

---

### `buildTarget`

**Purpose:** Build the project with sanitizer-instrumented compiler flags.

**Input Schema:**
```typescript
{
  projectPath: z.string(),          // project root (must exist on disk)
  buildCommand: z.string(),         // e.g. "make -j4" or "cmake --build ."
  timeoutSec: z.number().optional(), // default 300
}
```

**Handler:** `BuildTargetService.build()` at
`apps/dynamic-analyzer/src/services/build-target.service.ts:11-150

1. Validates `projectPath` exists on disk; returns error if not.
2. Adapts sanitizer flags for macOS (replaces `-fsanitize=leak` with
   `-fsanitize=address` since LSan is not standalone on Darwin).
3. Decides build mode based on platform:
   - **Linux (native):** Runs `execSync` with the adapted command string
     in the project directory. Default timeout 300s, 10 MB maxBuffer.
   - **macOS (Docker):** Used when sanitizer flags are present. Writes a
     build script, then runs `docker run --rm` with `gcc:latest` image.
     Container sandbox: `--network none`, `--memory 1g`, `--pids-limit 512`,
     project bind-mounted at `/workspace`. Uses `execFileSync` with argv
     (no shell injection) and `realpathSync` on mount source (symlink defense).
4. **Binary search:** After build completes, searches for output binary by:
   (a) extracting `-o <file>` from build log, (b) checking common names
   (`a.out`, `build/app`), (c) recursively searching up to 3 levels for
   executables (skipping `.git`, `node_modules`, hidden dirs).
5. Fallback: `<projectPath>/a.out`.

**Return Type:**
```typescript
{
  success: boolean;          // build succeeded?
  binaryPath: string;        // path to compiled binary (empty string if not found)
  buildLog: string;          // full build stdout
  errors: string[];          // stderr lines on failure
  docker?: boolean;          // present=true when Docker was used
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 12, "method": "tools/call",
  "params": { "name": "buildTarget", "arguments": { "projectPath": "/repo", "buildCommand": "make leakcheck", "timeoutSec": 600 } } }

// Response
{ "jsonrpc": "2.0", "id": 12, "result": { "content": [{ "type": "text", "text": "{\"success\":true,\"binaryPath\":\"/repo/a.out\",\"buildLog\":\"gcc -fsanitize=address -g -o a.out main.c\\n\",\"errors\":[],\"docker\":false}" }] } }
```

**Dependencies:** `runConfined()` (safe-exec), Docker daemon (on macOS).

**Platform Differences:**
- On **macOS** with sanitizer flags: builds inside Docker (`gcc:latest`). The
  container uses `--network none` and `--memory 1g` by default (overridable
  via `DYNAMIC_BUILD_*` env vars).
- On **Linux**: builds natively using `execSync`.

**Error Scenarios:** Missing `projectPath` → immediate error. Build failure →
`success: false` with error messages. Timeout → process killed, `success: false`.
Binary not found → `binaryPath: ""`.

---

### `valgrindMemcheck`

**Purpose:** Run Valgrind Memcheck for detailed leak analysis.

**Input Schema:**
```typescript
{
  binaryPath: z.string(),                    // compiled binary to analyze
  args: z.array(z.string()).optional(),      // CLI arguments for the binary
  runId: z.string().optional(),              // auto-generated as "vg_<timestamp>"
  timeoutSec: z.number().optional(),         // default 120
}
```

**Handler:** `ValgrindService.runMemcheck()` at
`apps/dynamic-analyzer/src/services/valgrind.service.ts:13-101

1. Sanitizes `runId` (alphanumeric only) to prevent path traversal.
2. Runs Valgrind with argv:
   `['--tool=memcheck', '--leak-check=full', '--xml=yes',
     '--xml-file=/tmp/<id>.xml', binaryPath, ...args]`
   via `runConfined()` with `unlimitedAddressSpace: true`.
3. Parses the XML output using `ResultParserService.parseValgrindXml()` —
   regex-based extraction of `<error>` blocks (kind, message, `<stack>` frames,
   `<origin/stack>`, `<leak>` bytes/blocks/kind).
4. Maps raw findings to `LeakFinding` via `toLeakFinding()`:
   - Finds first user-code stack frame (skipping `/usr/`, `/libc`, `/libgcc`)
   - Severity mapping: `invalidRead`/`invalidWrite`/`useAfterFree` → `high`,
     `definitelyLost` → `medium`, `possiblyLost` → `low`
5. Saves via `RunManagerService.saveRun()`.
6. Returns findings with summary statistics.

**Return Type:**
```typescript
{
  success: boolean;                    // Valgrind ran without crash
  runId: string;                       // sanitized run identifier
  findings: LeakFinding[];             // normalized leak findings
  summary: FindingSummary | string;    // stats object or error message
}
```

Where `LeakFinding`:
```typescript
{
  id: string;              // e.g. "mc-0001"
  tool: string;            // "memcheck"
  runId: string;
  functionName: string;
  filePath: string;
  lineNumber: number;
  bytesLost: number;
  blocksLost: number;
  severity: string;        // "high" | "medium" | "low"
  stackTrace: string;      // concatenated "function at file:line" per frame
  allocationType: string;  // e.g. "definitely_lost"
  status: string;          // always "open"
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 13, "method": "tools/call",
  "params": { "name": "valgrindMemcheck", "arguments": { "binaryPath": "/repo/a.out", "args": ["input.txt"], "timeoutSec": 120 } } }

// Response (abridged)
{ "jsonrpc": "2.0", "id": 13, "result": { "content": [{ "type": "text", "text": "{\"success\":true,\"runId\":\"vg_20260728T120000Z\",\"findings\":[{\"id\":\"mc-0001\",\"tool\":\"memcheck\",\"functionName\":\"load_config\",\"filePath\":\"/repo/src/main.c\",\"lineNumber\":42,\"bytesLost\":400,\"blocksLost\":1,\"severity\":\"medium\",\"allocationType\":\"definitely_lost\",\"status\":\"open\"}],\"summary\":{\"high\":0,\"medium\":1,\"low\":0,\"total\":1}}" }] } }
```

**Dependencies:** `runConfined()`, `RunManagerService`, `ResultParserService`.

**Platform Limitations:** Valgrind is Linux-only. On macOS, this tool will fail
at the process-spawn step. Use Docker for dynamic analysis on macOS.

---

### `valgrindGetReport`

**Purpose:** Retrieve a normalized Valgrind report from a previous run.

**Input Schema:**
```typescript
{
  runId: z.string(),
}
```

**Handler:** `ValgrindService.getReport()` at
`apps/dynamic-analyzer/src/services/valgrind.service.ts:105`

Delegates directly to `RunManagerService.getRun(runId)`, which reads the file
`<runs_dir>/<runId>.json`, parses as JSON, and returns the full `RunRecord`.

**Return Type:** `RunRecord | null`
```typescript
{
  runId: string;
  tool: string;         // "valgrind"
  binaryPath: string;
  output: string;       // raw Valgrind stdout/stderr
  findings: LeakFinding[];
  success: boolean;
  createdAt: string;    // ISO timestamp
}
// Returns null if runId doesn't exist
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 14, "method": "tools/call",
  "params": { "name": "valgrindGetReport", "arguments": { "runId": "vg_20260728T120000Z" } } }
```

**Dependencies:** `RunManagerService`.

**Error Scenarios:** Non-existent `runId` → returns `null` (successful response
with `null` text).

---

### `valgrindListFindings`

**Purpose:** Query Valgrind findings with optional filters.

**Input Schema:**
```typescript
{
  runId: z.string(),
  severity: z.string().optional(),      // filter by severity ("high" | "medium" | "low")
  functionName: z.string().optional(),  // declared but NOT used (see Known Issues)
}
```

**Handler:** `ValgrindService.listFindings()` at
`apps/dynamic-analyzer/src/services/valgrind.service.ts:109-113

1. Retrieves the full run record for the given `runId`.
2. Filters findings by `severity` if provided.
3. The `functionName` parameter is accepted but **not used** — the value is
   received via `_functionName` (prefixed underscore) and never referenced in
   the function body.

**Return Type:**
```typescript
{
  findings: LeakFinding[];
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 15, "method": "tools/call",
  "params": { "name": "valgrindListFindings", "arguments": { "runId": "vg_20260728T120000Z", "severity": "high" } } }
```

**Known Issues:**
- The `functionName` filter parameter is declared in the schema but **not
  implemented** — it is a stub. Filtering by function name will silently return
  all findings regardless of the value passed.

---

### `valgrindCompareRuns`

**Purpose:** Compare two Valgrind analysis runs.

**Input Schema:**
```typescript
{
  runIdA: z.string(),
  runIdB: z.string(),
}
```

**Handler:** `CompareService.compareValgrindRuns()` at
`apps/dynamic-analyzer/src/services/compare.service.ts:8-33

1. Loads both run records from disk via `RunManagerService.getRun()`.
2. If either run is missing, returns empty arrays.
3. Builds a `Map` for each run's findings, keyed by location:
   `"<functionName>:<filePath>:<lineNumber>"`.
4. Compares:
   - Findings in B but not A → `newFindings` (regressions)
   - Findings in A but not B → `fixedFindings` (fixes)
   - Findings in both → `unchanged` (persistent)

**Return Type:**
```typescript
{
  newFindings: LeakFinding[];    // regressions: in B not A
  fixedFindings: LeakFinding[];  // fixes: in A not B
  unchanged: LeakFinding[];      // persisted in both
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 16, "method": "tools/call",
  "params": { "name": "valgrindCompareRuns", "arguments": { "runIdA": "vg_20260728T120000Z", "runIdB": "vg_20260728T121500Z" } } }
```

**Known Issues:**
- Comparison is **location-only** (functionName:filePath:lineNumber). Two
  findings at the same location are considered identical even if their
  `bytesLost`, `severity`, or `allocationType` differ. A regression that
  increases bytesLost at the same site would go undetected.

---

### `asanRun`

**Purpose:** Run the binary under AddressSanitizer for leak detection.

**Input Schema:**
```typescript
{
  binaryPath: z.string(),
  args: z.array(z.string()).optional(),
  timeoutSec: z.number().optional(),    // default 120
}
```

**Handler:** `AsanService.run()` at
`apps/dynamic-analyzer/src/services/asan.service.ts:13`

1. Generates `runId` as `asan_<timestamp>` (sanitized).
2. Runs via `runConfined()` with `unlimitedAddressSpace: true` (ASan reserves
   ~20 TB of virtual address space for shadow memory).
3. Sets environment: `ASAN_OPTIONS=detect_leaks=1:verbosity=1`.
4. Captures stderr (where ASan reports leaks). Non-zero exit is treated as
   successful analysis (the report is captured either way).
5. Parses stderr using `ResultParserService.parseAsanOutput()` — scans for
   `ERROR: AddressSanitizer: <kind>` or `ERROR: LeakSanitizer: <kind>`, extracts
   stack frames (pattern `#N 0x... in func file:line`).
6. Saves via `RunManagerService.saveRun()`.

**Return Type:**
```typescript
{
  success: boolean;            // always true if ASan ran
  runId: string;
  findings: RawFinding[];      // parsed findings
  rawOutput: string;           // full stderr (or stdout fallback) text
}
```

Where `RawFinding`:
```typescript
{
  kind: string;                 // e.g. "heap-buffer-overflow", "use-after-free"
  message: string;
  stack: StackFrame[];          // [{function, file, line}]
  originStack: StackFrame[];    // always empty for ASan
  aux: Record<string, unknown>; // always empty for ASan
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 17, "method": "tools/call",
  "params": { "name": "asanRun", "arguments": { "binaryPath": "/repo/a.out", "args": [], "timeoutSec": 120 } } }
```

**Dependencies:** `runConfined()`, `RunManagerService`, `ResultParserService`.

---

### `lsanRun`

**Purpose:** Run the binary under LeakSanitizer.

**Input Schema:**
```typescript
{
  binaryPath: z.string(),
  args: z.array(z.string()).optional(),
  timeoutSec: z.number().optional(),    // default 120
}
```

**Handler:** `LsanService.run()` at
`apps/dynamic-analyzer/src/services/lsan.service.ts:13`

1. Generates `runId` as `lsan_<timestamp>` (sanitized).
2. Runs via `runConfined()` with `unlimitedAddressSpace: true`.
3. Sets environment: `LSAN_OPTIONS=verbosity=1:log_threads=1`.
4. Captures stderr.
5. Parses using `ResultParserService.parseLsanOutput()` — specialized parser for
   LSan's format: `"Direct leak of N byte(s) in M object(s) allocated from:"`
   followed by stack frames. Each leak block is parsed for bytes/blocks, each
   stack frame extracted.
6. **Fallback:** If no per-leak blocks are found but the output contains
   `LeakSanitizer: detected` or `LeakSanitizer: CHECK`, falls back to
   `parseAsanOutput()`.
7. Saves via `RunManagerService.saveRun()`.

**Return Type:**
```typescript
{
  success: boolean;            // always true if LSan ran
  runId: string;
  findings: RawFinding[];
  rawOutput: string;           // full stderr text
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 18, "method": "tools/call",
  "params": { "name": "lsanRun", "arguments": { "binaryPath": "/repo/a.out", "timeoutSec": 120 } } }
```

**Dependencies:** `runConfined()`, `RunManagerService`, `ResultParserService`.

**Platform Differences:**
- On **Linux (native):** LSan works standalone when the binary is compiled with
  `-fsanitize=leak` (or `-fsanitize=address` which includes LSan).
- On **macOS:** LSan is not available standalone. Use ASan instead (which
  includes LSan on Darwin). The `buildTarget` handler adapts `-fsanitize=leak`
  to `-fsanitize=address` automatically.

---

### `runBinary`

**Purpose:** Run a binary without instrumentation (plain execution).

**Input Schema:**
```typescript
{
  binaryPath: z.string(),
  args: z.array(z.string()).optional(),
  timeoutSec: z.number().optional(),    // default 60
}
```

**Handler:** `BinaryRunnerService.run()` at
`apps/dynamic-analyzer/src/services/binary-runner.service.ts:6`

- Runs the binary via `runConfined()` **without** `unlimitedAddressSpace`
  (the default ulimit `-v` cap applies).
- No sanitizer env vars are injected.
- Default timeout: **60 seconds** (shorter than sanitizer runs).
- Returns success based on exit code (`code === 0` and not timed out).
- On timeout, appends `[killed: exceeded Ns / resource limit]` to stderr.

**Return Type:**
```typescript
{
  success: boolean;      // exitCode === 0 && !timedOut
  stdout: string;        // full stdout
  stderr: string;        // full stderr (with kill note if timed out)
  exitCode: number;
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 19, "method": "tools/call",
  "params": { "name": "runBinary", "arguments": { "binaryPath": "/repo/a.out", "args": ["--version"] } } }
```

**Dependencies:** `runConfined()`.

---

### `buildHarness`

**Purpose:** Compile+link a TARGETED harness (Stage B2 — a driver calling just one
suspicious function/call-chain) against the REAL project's own compiler flags,
instead of building the whole project. Opt-in (`workflow.targetedHarness.enabled`).

**Input Schema:**
```typescript
{
  projectPath: z.string(),
  buildCommand: z.string(),
  harnessSource: z.string(),           // C/C++ source the caller wrote
  targetFile: z.string(),              // file defining the target function
  closureFiles: z.array(z.string()).optional(),  // files to compile+link alongside the harness
  entryStyle: z.enum(['single', 'fuzzer']),
  timeoutSec: z.number().optional(),
}
```

**Handler:** `HarnessBuildService.build()` at
`apps/dynamic-analyzer/src/services/harness-build.service.ts`

1. Validates `targetFile`/`closureFiles` resolve inside `realpathSync(projectPath)`.
2. `CompileCommandsService.capture()` ensures `compile_commands.json` exists at
   `projectPath` — running `bear -- sh -c '<buildCommand>'` via `runConfined()` if
   not already captured (NOT a nested Docker container — see docs/SECURITY.md
   "Targeted harness synthesis"). Returns `harness_unresolvable` if bear produces
   nothing (unsupported build system).
3. Looks up the captured compiler flags for `targetFile` (and each `closureFiles`
   entry, falling back to `targetFile`'s flags); keeps only reusable ones
   (`-I`/`-D`/`-U`/`-std=`/`-isystem`/`-include`/`-m*`) via `extractReusableFlags()`.
4. Writes `harnessSource` to `{RUNS_DIR}/{runId}/harness.{c,cpp}`.
5. Compiles each closure file `-c` with its own flags → `.o` (clang, `-fsanitize=address`).
6. Compiles+links the harness with the target file's flags, `-g -O0`, and
   `-fsanitize=address` (`entryStyle=single`) or `-fsanitize=fuzzer,address`
   (`entryStyle=fuzzer`) — always `clang` so both entry styles share one compiler.
7. Persists `{runId}.harnessbuild.json` metadata alongside the artifacts.

**Two linkage strategies** (chosen by the CALLER, via `harnessSource`/`closureFiles`
contents — not derived by this handler):
- **External linkage:** `harnessSource` `extern`-declares the target function;
  `closureFiles` lists the file(s) needed to link it.
- **`static` (internal) linkage:** `harnessSource` must `#include` the defining
  file directly (a separate TU can't link a `static` function); that file must
  NOT also appear in `closureFiles` (would define it twice).

**Return Type:**
```typescript
{
  success: boolean;
  binaryPath: string;      // analyzer-side path to the compiled harness
  runId: string;
  errors: string[];
  reason?: 'harness_unresolvable';   // structural failure — caller should fall back, not retry
}
```

**Dependencies:** `CompileCommandsService`, `runConfined()`.

---

### `libfuzzerRun`

**Purpose:** Run a harness binary built with `buildHarness(entryStyle="fuzzer")` for
a short BOUNDED time budget — the fuzz-tier escalation when a Stage B2 single-shot
run came back clean but the bundle is still borderline.

**Input Schema:**
```typescript
{
  binaryPath: z.string(),
  maxTotalTimeSec: z.number(),
  timeoutSec: z.number().optional(),   // default maxTotalTimeSec + 30
}
```

**Handler:** `LibfuzzerRunService.run()` at
`apps/dynamic-analyzer/src/services/libfuzzer-run.service.ts`

1. Runs via `runConfined()` with `-max_total_time=<budget> -runs=-1 -close_fd_mask=3`,
   `unlimitedAddressSpace: true` (same reasoning as `lsanRun`/`asanRun`).
2. Parses stderr/stdout with `ResultParserService.parseLsanOutput()` — a combined
   ASan+LSan(fuzzer) build reports leaks in the same format at exit.
3. Saves via `RunManagerService.saveRun()` (`tool: 'libfuzzer'`).

**Return Type:** same shape as `lsanRun`/`asanRun` — `{ success, runId, findings, rawOutput }`.

**Dependencies:** `runConfined()`, `RunManagerService`, `ResultParserService`.

---

### `listRuns`

**Purpose:** List stored dynamic analysis runs.

**Input Schema:**
```typescript
{
  tool: z.string().optional(),      // filter by tool name (e.g. "valgrind", "asan", "lsan")
  limit: z.number().optional(),     // default 50
}
```

**Handler:** `RunManagerService.listRuns()` at
`apps/dynamic-analyzer/src/services/run-manager.service.ts:44`

1. Reads all `.json` files from the runs directory (`./runs` or `RUNS_DIR` env var).
2. Parses each as JSON, skipping corrupt files (logged at debug level).
3. Filters by `tool` if provided.
4. Sorts by `createdAt` descending.
5. Limits to `limit` entries (default 50).
6. Returns `RunSummary[]` (strips full output and findings for lightness).

**Return Type:**
```typescript
{
  runs: RunSummary[];
  // RunSummary {
  //   runId: string;
  //   tool: string;
  //   binaryPath: string;
  //   createdAt: string;   // ISO timestamp
  //   success: boolean;
  // }
}
```

**JSON-RPC Example:**
```json
// Request
{ "jsonrpc": "2.0", "id": 20, "method": "tools/call",
  "params": { "name": "listRuns", "arguments": { "tool": "valgrind", "limit": 10 } } }
```

**Dependencies:** `RunManagerService`.

---

## 4. Domain Tools

These tools are registered by the **TUI orchestrator** (`leak-inspector-tui`),
not by either analyzer server. They are part of the tool surface presented to
the LLM sub-agents.

### `read_file`

**Purpose:** Read a source file from the repository (path relative to repo root
or absolute inside it). Returns up to 16 000 characters.

**File:** `apps/leak-inspector-tui/src/domain/readFileTool.ts:17-43`

Exposed to Stage A sub-agents alongside the 5 CONTENT_CAPABLE_TOOLS. This is
the **only remaining domain tool** in the TUI (the old `search_code` tool was
removed when the project went TUI-only).

```typescript
// Schema
{ path: z.string() }
```

### `done_static`

**Purpose:** Finish static evidence gathering for this group of candidates.

**File:** `workflowInvestigation.ts:202`

A terminal tool — when called, signals the orchestrator that the LLM sub-agent
has finished collecting static evidence. Returns `{ done: true }`.

### `done_dynamic`

**Purpose:** Finish dynamic evidence collection.

**File:** `workflowInvestigation.ts:265`

Same pattern as `done_static` — signals completion of dynamic evidence gathering.
Returns `{ done: true }`.

Both `done_*` tools are defined via `buildDoneTool()` in
`subAgentPrompts.ts:17-26`.

---

## 5. Pipeline Integration Summary

Cross-reference of every tool with its pipeline stage, execution policy, ScanPhase,
and whether it is exposed to the LLM agent.

| Tool | Server | Pipeline Stage | ScanPhase | Execution Policy | Agent-Exposed |
|---|---|---|---|---|---|
| `indexFiles` | Static | A (orchestrator) | DISCOVERY | CONCURRENCY_SAFE | ❌ |
| `candidateScan` | Static | A (sub-agent) | DISCOVERY | CONCURRENCY_SAFE | ✅ |
| `astScan` | Static | A (sub-agent) | INVESTIGATION | CONCURRENCY_SAFE | ✅ |
| `callGraph` | Static | A (orchestrator) | INVESTIGATION | CONCURRENCY_SAFE | ❌ |
| `functionSummary` | Static | A (sub-agent) | INVESTIGATION | CONCURRENCY_SAFE | ✅ |
| `interproceduralFlow` | Static | A (orchestrator) | INVESTIGATION | CONCURRENCY_SAFE | ❌ |
| `pathConstraints` | Static | A (sub-agent) | INVESTIGATION | CONCURRENCY_SAFE | ✅ |
| `ownershipSummary` | Static | A (orchestrator) | INVESTIGATION | CONCURRENCY_SAFE | ❌ |
| `ownershipConventions` | Static | A (sub-agent) | INVESTIGATION | CONCURRENCY_SAFE | ✅ |
| `scanBuildRun` | Static | A (orchestrator) | SCAN_BUILD | SERIAL_HEAVY | ❌ |
| `scanBuildGetReport` | Static | A (orchestrator) | SCAN_BUILD | CONCURRENCY_SAFE | ❌ |
| `buildTarget` | Dynamic | B (deterministic) | DYNAMIC | SERIAL_HEAVY | ❌ |
| `valgrindMemcheck` | Dynamic | B (deterministic) | DYNAMIC | SERIAL_HEAVY | ❌ |
| `valgrindGetReport` | Dynamic | B (orchestrator) | DYNAMIC | CONCURRENCY_SAFE | ❌ |
| `valgrindListFindings` | Dynamic | B (orchestrator) | DYNAMIC | CONCURRENCY_SAFE | ❌ |
| `valgrindCompareRuns` | Dynamic | B (orchestrator) | DYNAMIC | CONCURRENCY_SAFE | ❌ |
| `asanRun` | Dynamic | B (deterministic) | DYNAMIC | SERIAL_HEAVY | ❌ |
| `lsanRun` | Dynamic | B (deterministic) | DYNAMIC | SERIAL_HEAVY | ❌ |
| `runBinary` | Dynamic | B (deterministic) | DYNAMIC | SERIAL_HEAVY | ❌ |
| `listRuns` | Dynamic | B (orchestrator) | DYNAMIC | CONCURRENCY_SAFE | ❌ |
| `read_file` | TUI | A (sub-agent) | — | — | ✅ |
| `done_static` | TUI | A (sub-agent) | — | — | ✅ |
| `done_dynamic` | TUI | B (worker) | — | — | ✅ |

> **Pipeline stages** (see [ARCHITECTURE.md](./ARCHITECTURE.md) §5):
> - **Stage A:** Static fan-out — LLM sub-agents gather evidence using 5
>   CONTENT_CAPABLE_TOOLS + `read_file`. Orchestrator runs the remaining 6
>   static tools deterministically.
> - **Stage B:** Dynamic worker — deterministic recipe (`buildTarget` → one of
>   `valgrindMemcheck`/`asanRun`/`lsanRun`). No LLM involvement.
> - **Stage C:** Synthesize — merge evidence into bundles.
> - **Stage D:** Judge — heuristic judge (ALL bundles) + LLM judge (BORDERLINE only).

---

## 6. Appendix: Shared Type Reference

Key TypeScript interfaces referenced across the tools.

```typescript
// --- Raw/dynamic findings ---

interface LeakFinding {
  id: string;
  tool: string;            // "memcheck"
  runId: string;
  functionName: string;
  filePath: string;
  lineNumber: number;
  bytesLost: number;
  blocksLost: number;
  severity: string;        // "high" | "medium" | "low"
  stackTrace: string;
  allocationType: string;  // e.g. "definitely_lost"
  status: string;          // always "open"
}

interface RawFinding {
  kind: string;             // e.g. "heap-buffer-overflow"
  message: string;
  stack: StackFrame[];
  originStack: StackFrame[];
  aux: Record<string, unknown>;
}

interface StackFrame {
  function: string;
  file: string;
  line: number;
}

// --- Run records ---

interface RunRecord {
  runId: string;
  tool: string;
  binaryPath: string;
  output: string;
  findings: LeakFinding[];
  success: boolean;
  createdAt: string;        // ISO timestamp
}

interface RunSummary {
  runId: string;
  tool: string;
  binaryPath: string;
  createdAt: string;
  success: boolean;
}

// --- Static analysis ---

interface CandidateEntry {
  id: string;
  functionName: string;
  filePath: string;
  lineNumber: number;
  allocationSite: string;
  allocationType: string;   // "alloc" | "free" | "parameter_ownership"
  confidence: string;       // "high" | "medium" | "low"
  context: string;
  signature: string;
  observedDeallocationCount: number;
  earlyReturnLines: number[];
}

interface MemoryPattern {
  type: string;              // one of 8 leak pattern categories
  severity: string;
  functionName: string;
  line: number;
  description: string;
  context?: string;
}

interface FunctionScanSummary {
  functionName: string;
  allocCount: number;
  freeCount: number;
  ratio: number;
  loopCount: number;
  exitPathCount: number;
  confidence: string;
}

interface AllocFreePair {
  alloc: string;             // "malloc at line 42"
  free: string;              // "free at line 57"
  status: string;            // "paired" | "conditional" | "unpaired"
}

interface OwnershipSummary {
  role: string;              // "allocator" | "deallocator" | "both" | "neither"
  carrier: string;           // return value or parameter name
  rationale: string;
}

// --- Pipeline ---

enum ScanPhase {
  DISCOVERY = 'discovery',
  INVESTIGATION = 'investigation',
  SCAN_BUILD = 'scan_build',
  DYNAMIC = 'dynamic',
}
```

> Full type definitions are in:
> - `apps/static-analyzer/src/types/mcp-responses.ts`
> - `apps/dynamic-analyzer/src/types/mcp-responses.ts`
> - `packages/common/src/` (LeakBundle, VerdictResult, ScanReport)
