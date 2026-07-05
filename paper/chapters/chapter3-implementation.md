# Chương 3: Hiện thực, triển khai hệ thống

Một hệ thống phân tích memory leak dù được thiết kế tốt đến đâu, nếu chỉ tồn tại trên sơ đồ khối, cũng chưa thể kiểm chứng được. Chương này trình bày quá trình hiện thực hoá kiến trúc HYBRID pipeline đã đề cập ở Chương 2 — từ lựa chọn công cụ, cấu trúc thư mục, cho đến từng hàm cụ thể xử lý parsing AST, phối hợp sub-agent, và tổng hợp phán xét. Thay vì liệt kê công nghệ một cách khô khan, chúng tôi bắt đầu bằng cách giải thích tại sao từng lựa chọn được đưa ra.

---

## 3.1. Công nghệ sử dụng và cấu trúc dự án

### 3.1.1. Lựa chọn ngôn ngữ và runtime

Hệ thống được viết hoàn toàn bằng TypeScript, chạy trên Bun runtime. Đây là quyết định có phần đi ngược số đông — phần lớn công cụ phân tích code C/C++ (Clang SA [1], Infer, CodeQL) đều viết bằng C++ hoặc OCaml. Tuy nhiên, mục tiêu của luận văn không phải xây thêm một analyzer từ đầu, mà xây một **orchestrator** điều phối nhiều analyzer có sẵn qua giao thức MCP [42]. Với bài toán này, TypeScript có mấy lợi thế cụ thể:

Thứ nhất, MCP SDK chính thức (`@modelcontextprotocol/sdk`) chỉ có bản TypeScript/JavaScript. Dùng ngôn ngữ khác nghĩa là tự implement lại giao thức từ zero — một khoản nợ kỹ thuật không đáng có. Thứ hai, Tree-sitter [4] — thư viện parse AST mà static analyzer dựa vào — có binding Node.js trưởng thành, hỗ trợ cả grammar C (`tree-sitter-c`) và C++ (`tree-sitter-cpp`) với tốc độ parse hàng triệu dòng/giây. Thứ ba, hệ thống cần streaming SSE cho LLM response, HTTP server cho MCP endpoint, và terminal UI — tất cả đều là thế mạnh của hệ sinh thái JavaScript/TypeScript.

Bun được chọn thay vì Node.js vì tốc độ khởi động nhanh hơn khoảng 3–5× trong các benchmark nội bộ (đặc biệt quan trọng khi chạy hàng trăm test case trong ablation study), và vì Bun hỗ trợ native `crypto.randomUUID()` mà không cần polyfill.

### 3.1.2. Kiến trúc monorepo Turborepo

Toàn bộ workspace được tổ chức theo mô hình monorepo với Turborepo quản lý dependency graph và task pipeline. Cấu trúc thư mục như sau:

```
Thesis/
├── apps/
│   ├── static-analyzer/     ← NestJS MCP service, port 50061
│   ├── dynamic-analyzer/    ← NestJS MCP service, port 50062
│   └── leak-inspector-tui/  ← Ink TUI, orchestrator chính
├── packages/
│   ├── common/              ← @cleak/common: types, Zod schemas, judges, renderers
│   └── agent-core/          ← @cleak/agent-core: tool-calling loop, providers, MCP client
├── docker-compose.yml
├── turbo.json
└── package.json
```

`turbo.json` định nghĩa pipeline build gồm 5 task: `build` (output `dist/**`, phụ thuộc `^build`), `dev` (persistent, không cache), `typecheck`, `lint`, và `test` (phụ thuộc `build`). Task `build` sử dụng tsup cho việc bundle — mỗi app/package có `tsup.config.ts` riêng, xuất ESM module.

Hai NestJS apps (`static-analyzer`, `dynamic-analyzer`) dùng framework NestJS cho dependency injection và lifecycle management, nhưng điểm mấu chốt là chúng **không** expose REST controller hay gRPC như thông thường. Thay vào đó, `main.ts` của mỗi app khởi tạo DI context rồi gọi `createStaticMcpServer()` / `createDynamicMcpServer()` để serve MCP/HTTP trực tiếp. Quyết định loại bỏ gRPC (và toàn bộ `proto/` directory) được đưa ra sau khi xác nhận rằng không còn consumer nào cho gRPC sau khi hệ thống web bị xoá khỏi master.

### 3.1.3. Các framework và thư viện chính

Bảng 3.1 tổng hợp các thư viện cốt lõi và vai trò cụ thể của chúng trong hệ thống.

| Thư viện | Phiên bản | Vai trò trong hệ thống |
|---|---|---|
| `@modelcontextprotocol/sdk` | ≥1.0 | MCP server (analyzer) + client (TUI) — giao thức chuẩn để orchestrator gọi analyzer |
| `@nestjs/core`, `@nestjs/common` | ≥10 | DI container + lifecycle cho static-analyzer và dynamic-analyzer |
| `tree-sitter`, `tree-sitter-c`, `tree-sitter-cpp` | ≥0.21 | Parse AST C/C++ — backbone của toàn bộ static analysis |
| `ink` (React for CLI) | ≥4 | Terminal UI framework — render kết quả realtime trong terminal |
| `zod` | ≥3 | Schema validation cho MCP tool input, config file, allocator profile, corpus manifest |
| `tsx` / `tsup` | latest | Dev server (tsx) + production bundle (tsup) |

Điều đáng chú ý là hệ thống **không** dùng bất kỳ framework AI/agent nào (LangChain, CrewAI, AutoGen). Vòng lặp tool-calling được implement thủ công trong `packages/agent-core/src/loop.ts` — một async generator khoảng 280 dòng, xử lý tool dispatch, permission resolution, context compaction, và completion guard. Lý do: các framework agent thêm một lớp abstraction không cần thiết khi orchestrator chỉ cần native function-calling (tool_use/tool_result) mà mọi LLM provider lớn đều hỗ trợ.

---

## 3.2. Cài đặt static analyzer

### 3.2.1. C-parser service: routing C/C++ và quản lý allocator

Static analyzer bắt đầu từ `CParserService` — một NestJS injectable service đóng vai trò parser trung tâm. Mọi tool phân tích (candidateScan, astScan, functionSummary, pathConstraints, callGraph, interproceduralFlow) đều gọi `cParser.parse()` để nhận kết quả AST trước khi thực hiện phân tích chuyên biệt.

Vấn đề đầu tiên cần giải quyết là routing ngôn ngữ. Tree-sitter-c và tree-sitter-cpp là hai grammar riêng biệt — dùng grammar sai sẽ dẫn đến parse error hoặc AST sai (ví dụ: tree-sitter-c không hiểu `new`/`delete`, template, hay toán tử `::`). Service xác định grammar dựa trên phần mở rộng file:

```typescript
static isCppPath(filePath?: string): boolean {
  return /\.(cc|cpp|cxx|c\+\+|hpp|hxx|hh|ipp|tcc|inl)$/i.test(filePath || '');
}
```

Hai parser (C và C++) được lazy-initialize và reuse qua toàn bộ vòng đời service — mỗi parser chỉ tạo một lần, lần đầu cần dùng. Kết quả parse được cache theo content hash trong một Map bounded (tối đa 512 entries) để tránh parse lại cùng một file khi nhiều tool gọi liên tiếp.

Một thiết kế quan trọng khác là cơ chế threading allocator set. Hardcoded set mặc định chỉ gồm các hàm libc cơ bản: `malloc`, `calloc`, `realloc`, `strdup`, `free`, và các biến thể kernel (`kmalloc`, `kfree`). Nhưng các dự án thực tế sử dụng factory allocator riêng — cJSON có `cJSON_CreateObject()`/`cJSON_Delete()`, libtiff có `_TIFFmalloc()`/`_TIFFfree()`. Nếu chỉ dựa vào set mặc định, hệ thống sẽ miss hoàn toàn các allocation site này.

Giải pháp: mỗi lần gọi `parse()`, caller có thể truyền `extraAllocators` và `extraDeallocators` — danh sách tên hàm cụ thể cho dự án đó. Các tên này được validate bằng regex (`/^[A-Za-z_]\w*$/`) trước khi merge vào set hiện tại. Danh sách extra này được phát hiện bởi tầng LLM-generalization (mục 3.7.1) và threading xuyên suốt **tất cả** 7 static tool — từ candidateScan (phát hiện allocation site) đến functionSummary (cặp hoá alloc→free) đến pathConstraints (theo dõi biến chưa free trên exit path).

### 3.2.2. Đăng ký 11 MCP tools

Static analyzer expose 11 tools qua MCP/HTTP, được đăng ký trong `createStaticMcpServer()`. Mỗi tool được khai báo với Zod `inputSchema` — MCP SDK sử dụng Zod schema trực tiếp làm JSON Schema cho tool description, nên client (TUI) biết chính xác kiểu dữ liệu cần gửi.

Bảng 3.2 liệt kê đầy đủ 11 tools và chức năng:

| Tool | Chức năng | Input chính |
|---|---|---|
| `indexFiles` | Quét đệ quy tất cả file C/C++ từ root path | `rootPath`, `fileLimit?`, `excludePatterns?` |
| `candidateScan` | Lexical scan tìm allocation site (malloc, new, factory) | `filePath`, `content?`, `extraAllocators?`, `extraDeallocators?` |
| `astScan` | Phân tích cấu trúc AST cho memory leak pattern | `filePath`, `content?` |
| `callGraph` | Trích xuất đồ thị gọi hàm | `rootPath`, `files[]`, `extraAllocators?`, `extraDeallocators?` |
| `functionSummary` | Tóm tắt hàm: alloc/free balance, exit path | `filePath`, `content?`, `functionName`, `extraAllocators?`, `extraDeallocators?` |
| `pathConstraints` | Phân tích ràng buộc đường đi quanh allocation | `filePath`, `content?`, `lineNumber`, `extraAllocators?`, `extraDeallocators?` |
| `interproceduralFlow` | Truy vết alloc/free liên hàm | `rootPath`, `functionName`, `files[]`, `extraAllocators?`, `extraDeallocators?` |
| `ownershipSummary` | Tóm tắt quy ước ownership qua nhiều file | `files[]`, `rootPath` |
| `ownershipConventions` | Phát hiện quy ước transfer ownership trong file | `content?`, `filePath` |
| `scanBuildRun` | Chạy Clang Static Analyzer (scan-build) | `projectPath`, `buildCommand`, `timeoutSec?` |
| `scanBuildGetReport` | Lấy kết quả scan-build | `runId` |

Chức năng `ok()` wrapper chuyển mọi kết quả service thành format MCP chuẩn: `{ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }`. Cách tiếp cận này giữ cho MCP server mỏng — toàn bộ logic phân tích nằm trong các service, server chỉ đóng vai trò routing.

### 3.2.3. Phân tích path-sensitive: guard-subset reconciliation

Đây là phần phức tạp nhất của static analyzer, và cũng là phần trải qua nhiều lần refactor nhất. Bài toán cơ bản: cho một allocation site, xác định những exit path nào của hàm sẽ **mất** con trỏ đã cấp phát mà không giải phóng.

`PathConstraintsService.analyze()` nhận vào `filePath`, `content`, và `lineNumber` (dòng allocation). Bước đầu tiên là xác định hàm chứa allocation — service tìm hàm innermost bằng tree-sitter range (`fn.lineNumber ≤ lineNumber ≤ fn.endLine`), sort theo kích thước range tăng dần để chọn hàm lồng nhau đúng nhất.

Từ kết quả parse, service trích xuất tất cả exit paths của hàm. Mỗi exit path được gán nhãn `leakRisk` dựa trên phân tích guard-subset reconciliation — một kỹ thuật tự phát triển, lấy cảm hứng từ cách Clang SA [1] xử lý path condition nhưng đơn giản hơn đáng kể:

**Nguyên tắc cơ bản:** Nếu một biến `ptr` được cấp phát trong hàm, và trên một exit path nào đó, `ptr` bị free bởi một lệnh free nằm dưới **cùng điều kiện guard** (hoặc guard con) với allocation, thì cặp alloc→free được coi là "hoà giải" (reconciled) trên path đó. Ngược lại, nếu exit path có allocation nhưng không có free tương ứng, hoặc free nằm dưới guard khác, biến đó là "unreconciled" — một dấu hiệu leak.

Ví dụ cụ thể: trong hàm `process()` của cJSON, `merge_patch` được cấp phát ở dòng 50, và `cJSON_Delete(merge_patch)` chỉ xuất hiện ở nhánh else (dòng 65). Nhánh if (dòng 58) return NULL mà không giải phóng — đây là exit path unreconciled, leak risk = high.

Mỗi exit path còn được gắn thêm mảng `guards` — danh sách các điều kiện bao quanh (kể cả polarity: bị phủ định hay không). Thông tin này cho phép heuristic judge phân biệt giữa "free nằm trong cùng nhánh với alloc" (an toàn) và "free nằm ở nhánh khác" (có thể leak).

### 3.2.4. Reachability bảo thủ: collectDeadLines

Một vấn đề thực tế khi phân tích CFG: không phải mọi exit path đều thật sự reachable. Nếu một hàm có `return` ở dòng 10 và `return` ở dòng 20, thì dòng 20 chỉ reachable nếu không có unconditional terminator (goto, exit, abort) giữa dòng 10 và 20.

`collectDeadLines()` trong CParserService xử lý bài toán này bằng cách duyệt tuần tự các statement trong hàm. Khi gặp unconditional terminator (`return`, `goto`, `exit()`, `abort()`), tất cả các statement **sau** nó cho đến label đích tiếp theo (nếu là goto) hoặc closing brace (nếu là return) đều bị đánh dấu là dead code. Exit paths bắt đầu từ dead code bị loại khỏi danh sách reachable.

Cách tiếp cận này cố tình bảo thủ — nó chỉ detect unconditional terminator, không suy luận sâu về điều kiện luôn đúng (ví dụ `if (true)`). Lý do: mục tiêu là giảm FP (false positive), không phải tối đa hoá recall. Một exit path bị đánh sai là unreachable (thực tế là reachable) chỉ gây ra miss leak — nhưng một exit path unreachable bị giữ lại sẽ tạo FP.

### 3.2.5. Parameter-ownership leak

Một biến thể leak mà các công cụ truyền thống thường bỏ sót: hàm nhận một con trỏ tham số, giải phóng nó trên **một số** path nhưng không giải phóng trên path khác. cJSON là ví dụ điển hình — `cJSONUtils_MergePatch(caseSensitive, target, patch)` gọi `cJSON_Delete(target)` trên nhánh error nhưng không gọi trên nhánh thành công (vì `target` được modify in-place và caller vẫn sở hữu).

Hệ thống phát hiện pattern này bằng cách kiểm tra: (a) một tham số kiểu con trỏ xuất hiện trong lệnh free nào đó của hàm, và (b) có exit path nào reachable mà không có free tương ứng. Nếu cả hai điều kiện đúng, một synthetic candidate được tạo với `allocation_type = 'parameter_ownership'` — cho phép heuristic judge và LLM judge đánh giá nó như một allocation site bình thường.

---

## 3.3. Cài đặt dynamic analyzer

### 3.3.1. Build orchestration và sanitizer injection

Dynamic analyzer đảm nhận việc biên dịch dự án với sanitizer flags, chạy binary đã instrument, và parse kết quả. Quá trình build được orchestrate bởi tool `buildTarget` — nhận `projectPath` và `buildCommand` từ caller, inject thêm sanitizer flags, rồi thực thi trong child_process.

Hai sanitizer chính được hỗ trợ:

- **LeakSanitizer (LSan):** flag `-fsanitize=leak -g -O0`. LSan là sanitizer chuyên dụng cho leak detection, chạy tại exit point của chương trình và báo cáo các block chưa giải phóng. Ưu điểm: không abort mid-run (khác ASan), output format dễ parse.
- **AddressSanitizer (ASan):** flag `-fsanitize=address`. ASan detect broader class lỗi (buffer overflow, use-after-free) nhưng leak detection chỉ là tính năng phụ. Dùng khi cần coverage cho cả memory error lẫn leak.

Một chi tiết kỹ thuật quan trọng: ASan và LSan reserve khoảng 20TB virtual address space cho shadow memory. Trên môi trường có `ulimit -v` giới hạn, quá trình này sẽ crash ngay lập tức với lỗi mmap. Dynamic analyzer xử lý bằng cách set `unlimitedAddressSpace = true` trước khi spawn child process — tương đương `ulimit -v unlimited` trong shell.

### 3.3.2. Valgrind integration

Bên cạnh compiler-based sanitizer, hệ thống còn tích hợp Valgrind Memcheck [7] — một binary instrumentation tool chạy trên Linux. Valgrind không cần recompile (khác sanitizer), nhưng chậm hơn khoảng 10–50×.

Việc tích hợp tương đối đơn giản: spawn `valgrind --tool=memcheck --leak-check=full --show-leak-kinds=all <binary>` trong child_process, capture stderr (nơi Valgrind ghi output), rồi parse kết quả thành normalized report. Report parser xử lý format chuẩn của Valgrind: mỗi leak block gồm header (`definitely lost: X bytes`), stack trace, và allocation context.

### 3.3.3. llvm-symbolizer

Một dependency bắt buộc nhưng dễ bị bỏ qua: sanitizer output chỉ chứa địa chỉ hex (`0x4a2b3c`) nếu không có symbolizer. Dynamic analyzer yêu cầu `llvm-symbolizer` có sẵn trong PATH — tool này chuyển đổi địa chỉ thành `file:line:function` mà LLM judge cần để liên kết finding với source code.

### 3.3.4. Đăng ký 9 MCP tools

Bảng 3.3 liệt kê 9 tools của dynamic analyzer:

| Tool | Chức năng |
|---|---|
| `buildTarget` | Build dự án với sanitizer-instrumented compiler |
| `valgrindMemcheck` | Chạy Valgrind Memcheck |
| `valgrindGetReport` | Lấy normalized Valgrind report |
| `valgrindListFindings` | Query Valgrind findings với filter |
| `valgrindCompareRuns` | So sánh hai Valgrind runs |
| `asanRun` | Chạy binary dưới AddressSanitizer |
| `lsanRun` | Chạy binary dưới LeakSanitizer |
| `runBinary` | Chạy binary không instrument |
| `listRuns` | Liệt kê các dynamic analysis runs đã lưu |

Cấu trúc đăng ký tương tự static analyzer: Zod `inputSchema`, `ok()` wrapper, delegation tới service methods. Điểm khác biệt là dynamic analyzer có thêm `RUNS_DIR` volume mount (mặc định `/runs` trong Docker) để lưu artifact giữa các run.

---

## 3.4. Cài đặt agent core

### 3.4.1. Vòng lặp tool-calling native

`packages/agent-core` là trái tim của hệ thống — nơi LLM và tools giao tiếp với nhau. Module chính là `queryLoop()` trong `loop.ts`, một async generator implement vòng lặp: hỏi model → nhận text + tool_use → dispatch tools → thread tool_result → lặp lại.

Mỗi iteration (turn) gồm 5 bước:

1. **Compaction check:** Ước tính kích thước prompt (dựa trên `lastInputTokens` từ model response, hoặc heuristic 4 chars/token). Nếu vượt `thresholdTokens` (mặc định 100,000), các tool_result cũ ngoài `keepRecentTurns` turns gần nhất được prune in-place — thay bằng placeholder `[elided: N chars of stale tool output pruned to save context]`. Cách này giữ nguyên message structure (không phá tool_use↔tool_result pairing) trong khi giảm rõ rệt kích thước prompt. Trong thực nghiệm, compaction thường tiết kiệm 30–50% token khi sub-agent đã chạy 8+ turns.

2. **Model call:** Gọi `deps.callModel()` với system prompt, messages, và tool definitions. Response được streaming (SSE) — chunk đầu tiên trigger `onModelActivity('receive')` để TUI hiển thị indicator.

3. **Permission resolution:** Mỗi tool_use request đi qua `tool.checkPermissions()`. Static tools luôn auto-allow (read-only); dynamic tools có thể yêu cầu user approval trong interactive mode.

4. **Tool dispatch:** Các tool call được phân thành hai nhóm — read-only + concurrency-safe chạy song song (giới hạn bởi `concurrency`, mặc định 10), còn lại chạy tuần tự. `mapWithLimit()` quản lý pool worker.

5. **Terminal check:** Nếu tool vừa chạy nằm trong `terminalTools` set (ví dụ `done_static`, `done_dynamic`), vòng lặp kết thúc với reason `'finalized'`.

### 3.4.2. Completion nudge mechanism

Một vấn đề thực tế: LLM đôi khi dừng sớm trước khi hoàn thành công việc — ví dụ sub-agent chỉ gather evidence cho 2 trong 4 candidates rồi tuyên bố "done". Cơ chế `checkCompletion` giải quyết vấn đề này.

Khi model trả về response không có tool_use (tức muốn dừng), loop gọi `checkCompletion()` — hàm do caller cung cấp. Nếu có công việc chưa xong, hàm trả về chuỗi nudge (ví dụ: `"You stopped, but 2 candidate(s) have NO static evidence yet: id-1, id-2. Run functionSummary/pathConstraints for them, then call done_static."`). Nudge này được inject làm user message, buộc model tiếp tục.

Budget nudge tối đa là `maxStopNudges` (mặc định 3). Counter reset mỗi khi model gọi tool thành công — nghĩa là nudge chỉ áp dụng cho các turn mà model "nghỉ ngơi" mà không làm gì. Cơ chế này ngăn model loop vô hạn trong khi vẫn cho phép nó recover từ stop sớm.

### 3.4.3. Multi-provider streaming

Hệ thống hỗ trợ 4 loại provider, được chọn qua config `provider`:

- **`local`:** OpenAI-compatible endpoint (mặc định `http://localhost:20128/v1`, model `mimo/mimo-v2.5-pro`). Đây là cấu hình chính cho thực nghiệm.
- **`openai`:** OpenAI API trực tiếp.
- **`anthropic`:** Anthropic Messages API — cần adapter riêng vì format khác OpenAI.
- **`openai-compat`:** Bất kỳ endpoint nào tuân thủ OpenAI Chat Completions API.

`callOpenAiChat()` trong `providers/openaiChat.ts` xử lý cả `local` và `openai-compat` — hai loại này chỉ khác nhau ở baseUrl và auth. Request gửi `stream: true, stream_options: { include_usage: true }` để nhận token usage realtime. Native function-calling được dùng (body có `tools` và `tool_choice: 'auto'`), không phải ReAct text parsing.

Idle timeout (mặc định 75 giây) reset theo mỗi chunk nhận được — không phải tổng thời gian chạy. Cách này cho phép một request chạy lâu (ví dụ model đang suy nghĩ về code phức tạp) mà không bị timeout, trong khi vẫn detect được connection chết (không nhận chunk nào trong 75 giây).

---

## 3.5. Cài đặt orchestrator (leak-inspector-tui)

### 3.5.1. Workflow 4-stage

Orchestrator là ứng dụng chính — nơi tất cả thành phần ghép lại với nhau. File `workflowInvestigation.ts` implement pipeline 4-stage đã thiết kế ở Chương 2.

**Stage A — Static evidence (fan-out bounded):**

Giai đoạn này spawn nhiều sub-agent chạy song song, mỗi agent负责 một nhóm candidates. Việc nhóm candidates theo file affinity (`groupByFileAffinity()`) đảm bảo các allocation site trong cùng một file luôn thuộc cùng một sub-agent — cho phép agent quan sát interprocedural pattern (allocator và freeing sink trong cùng file).

Mỗi sub-agent nhận: (a) system prompt hướng dẫn gather evidence bằng 5 static tools, (b) user message liệt kê candidates của nó, (c) tool set gồm `functionSummary`, `pathConstraints`, `astScan`, `ownershipConventions`, `read_file`, và `done_static`. Agent chạy trong `queryLoop` riêng, context hoàn toàn cách ly — output được fold vào `staticStore` (Map<string, Record<string, any>>) qua wrapper `withStaticContextCapture()`.

Concurrency mặc định cho Stage A: 3 sub-agent đồng thời (`staticConcurrency`), mỗi nhóm tối đa 4 candidates (`staticGroupSize`). Các con số này dựa trên thực nghiệm: nhiều hơn 3 sub-agent gây áp lực lên LLM gateway (đặc biệt với local model), và group size 4 đủ nhỏ để context mỗi agent không vượt quá 8,000–10,000 tokens.

Khi `toolSelect = false` (ablation baseline không có agentic tool selection), Stage A bị bỏ qua hoàn toàn — static evidence đến từ deterministic enrichment stage chạy trước đó.

**Stage B — Dynamic evidence (chạy đồng thời với A):**

Stage B chạy concurrently với Stage A (dùng `Promise.all`). Có hai path:

*Deterministic path:* Khi `buildCommand` đã biết, hệ thống chạy `runDeterministicDynamic()` — gọi `buildTarget` rồi `lsanRun` theo thứ tự cố định, không có LLM nào trong loop. Kết quả sanitizer được capture tự động bởi wrapper `withDynamicEvidenceCapture()`.

*LLM fallback:* Khi build system không rõ, một LLM worker nhận dynamicWorkerSystemPrompt — hướng dẫn đọc Makefile/CMakeLists, build với sanitizer flags, rồi chạy. Worker cũng bị giới hạn: build tối đa 1 lần, mỗi dynamic tool tối đa 1 lần.

Quan trọng: dù dùng path nào, việc capture evidence là **deterministic**. Wrapper `withDynamicEvidenceCapture()` ghi nhận raw finding từ sanitizer tool — LLM chỉ quyết định tool nào gọi, không quyết định finding nào được ghi.

**Stage C — Synthesize (deterministic):**

Giai đoạn này không có LLM. `reconcileDynamicEvidence()` fold mỗi dynamic finding vào bundle tương ứng tốt nhất (dựa trên correlation rank: cùng function > cùng file > cùng allocation type). `computeDynamicCoverage()` gán explicit coverage status cho mỗi bundle: `exercised_leak`, `exercised_clean`, hoặc `not_exercised`.

**Stage D — Hybrid judge:**

Giai đoạn cuối cùng. Mỗi bundle nhận heuristic verdict trước (`heuristicVerdict()`). Các bundle borderline — defined là `likely_leak`/`uncertain` HOẶC confidence nằm trong khoảng [0.35, 0.7] — được escalate lên LLM judge hoặc consensus judge.

### 3.5.2. LLM judge và escalation logic

`judgeBundleWithLlm()` trong `llmJudge.ts` gửi cho model: (a) system prompt dài khoảng 500 từ với rubric chi tiết, (b) source snippet hàm chứa allocation (comments stripped để không leak benchmark labels), (c) tóm tắt static context (ownership, alloc→free pairs, feasible leak paths), và (d) runtime evidence nếu có.

Model bắt buộc trả JSON: `{verdict, confidence, explanation, evidence}`. Response được parse bằng Zod, sau đó enrich bởi `enrichLeakVerdict()` — đảm bảo mọi leak verdict đều có root cause và repair diff.

Logic `shouldEscalate()` quyết định bundle nào cần LLM second opinion:
```typescript
function shouldEscalate(bundle: LeakBundle): boolean {
  const v = bundle.verdict;
  if (!v) return true;
  // Borderline verdict
  if (v.verdict === 'likely_leak' || v.verdict === 'uncertain') return true;
  // Borderline confidence
  if (v.confidence >= 0.35 && v.confidence <= 0.7) return true;
  // Static↔verdict contradiction
  if (hasStaticEvidence(bundle) && v.verdict === 'false_positive') return true;
  return false;
}
```

### 3.5.3. Consensus judge: K-sample voting

Khi `cfg.consensus.n > 1`, Stage D chuyển sang chế độ consensus — gọi LLM judge N lần (mỗi lần temperature > 0 để tạo diversity) rồi kết hợp bằng `combineVerdicts()`.

Ba rule kết hợp:

- **`majority`:** Đơn giản nhất — hơn nửa samples đồng ý flag thì flag.
- **`weighted`:** Mỗi vote có weight = confidence. Vote contradict dynamic evidence bị giảm weight ×0.3 (flagging cleared site hoặc clearing confirmed leak).
- **`unanimous-to-flag`:** Bảo thủ nhất — tất cả samples phải đồng ý mới flag.

Sau khi combine, heuristic precision-override kiểm tra: nếu heuristic có strong exculpation (confidence ≥ 0.75, verdict `likely_false_positive` hoặc `false_positive`) VÀ dynamic không confirm leak → consensus flag bị veto. Override chỉ xoá flag, không bao giờ thêm — recall của LLM được bảo toàn.

---

## 3.6. Cài đặt common library (@cleak/common)

### 3.6.1. Heuristic judge: scoring function

`heuristic-judge.ts` là module quan trọng nhất của `@cleak/common` — nó tạo verdict cho **mọi** bundle, dù ở chế độ no_llm hay llm_assisted. Scoring function tính điểm trên thang [0, 1] dựa trên nhiều tín hiệu:

| Tín hiệu | Điểm | Điều kiện |
|---|---|---|
| Runtime leak correlated | +0.50 | definitely_lost/asan_leak, linked to candidate |
| Runtime leak correlated (possibly_lost) | +0.20 | linked, nhưng leak kind yếu |
| Unpaired alloc→free | +0.25 | Biến allocation không có free nào |
| Conditional alloc→free | +0.15 | Free trên một số path, không free trên path khác |
| Feasible leak path reachable | +0.20 | Exit path reachable, unreconciled allocation |
| Path-sensitive leak | +0.15 | Conditional + reachable exit leak |
| Allocator role, no ownership out | +0.15 | Allocator trả về local, không transfer |
| Early return skip cleanup | +0.10 | Hàm có nhiều return, allocation có thể bị skip |
| Clang scan-build corroboration | +0.15 | scan-build báo leak cho candidate này |
| Structural high | +0.50 | Phân tích cấu trúc xác định missing free |
| Ownership transferred | −0.25 | Ownership trả caller/sink (không có runtime leak) |

Ngưỡng phán xét: `confirmed ≥ 0.7`, `likely ≥ 0.4`. Đây là frozen benchmark defaults — thực nghiệm luôn dùng giá trị này để đảm bảo công bằng.

Hai precision gate ngăn FP:

*Gate 1 — Dynamic cleared:* Sanitizer chạy và không báo leak cho site này, static signals yếu → `likely_false_positive` (confidence 0.8). Gate này không kích hoạt cho real leak vì Juliet `*_bad` hoặc leak ở runtime (correlated) hoặc không free ở đâu (structural high).

*Gate 2 — Strong signal required:* Muốn flag leak, phải có ít nhất một tín hiệu mạnh (correlated runtime leak, structural high, unpaired alloc→free, path-sensitive leak, hoặc ownership issue). Một đống heuristic lexical yếu không đủ.

### 3.6.2. Consensus judge: combineVerdicts

Module `consensus-judge.ts` là đóng góp cốt lõi C1 của luận văn. Hàm `combineVerdicts()` là pure function (không I/O), hoàn toàn unit-testable.

Trước khi vote, hàm `deriveFusion()` tóm tắt bằng chứng thành hai trục:
- **Static:** `'leak'` (unpaired alloc hoặc reachable leak path), `'clean'` (ownership handed out), hoặc `'ambiguous'`.
- **Dynamic:** `'confirmed'` (runtime leak correlated), `'cleared'` (sanitizer chạy clean), hoặc `'none'`.

Vote weight trong rule `weighted` bị ảnh hưởng bởi fusion: nếu dynamic `'cleared'` mà vote vẫn flag → weight giảm ×0.3. Ngược lại, dynamic `'confirmed'` mà vote clear → cũng giảm ×0.3. Cơ chế này tạo "giọng nói" cho bằng chứng runtime — sanitizer đã chạy sạch thì LLM khó mà flag bừa.

### 3.6.3. Report renderers

`@cleak/common` cung cấp 4 renderer: JSON (machine-readable), Markdown (human-readable), HTML (styled web-viewable), và snapshot (experiment comparison format kèm metadata). Mọi renderer đều nhận cùng một `ScanReport` object — đảm bảo tính nhất quán giữa các format.

---

## 3.7. Cài đặt tầng LLM-generalization (POLICY)

Nguyên tắc cốt lõi xuyên suốt hệ thống: **LLM sở hữu POLICY, engine sở hữu MECHANISM**. Phần này trình bày ba module nơi LLM đề xuất quyết định theo-từng-project, còn engine thực thi quyết định đó một cách tất định.

### 3.7.1. Allocator profiler

`allocatorProfiler.ts` giải quyết bài toán: làm sao biết dự án nào dùng allocator nào mà không hardcode?

Quy trình gồm 4 bước:

1. **Gather project text:** Duyệt file C/C++ trong dự án, ưu tiên header files (chứa public API) và file mang tên dự án (ví dụ `cJSON.h`, `cJSON.c`). Budget mặc định 40,000 ký tự (~13k tokens). Source files bị cap 6,000 ký tự/file để một file lớn không chiếm hết budget.

2. **LLM inference:** Gửi project text cho model, yêu cầu liệt kê allocators, deallocators, reallocators, và ownership notes. Response được parse bằng Zod schema:
   ```typescript
   const AllocatorProfileSchema = z.object({
     allocators: z.array(z.string()).default([]),
     deallocators: z.array(z.string()).default([]),
     reallocators: z.array(z.string()).default([]),
     ownershipNotes: z.array(z.string()).default([]),
   });
   ```

3. **Grep-verify:** Mỗi tên LLM đề xuất được verify bằng cách grep trong source — nếu tên không xuất hiện, nó bị loại. Bước này ngăn hallucination (LLM "bịa" ra tên hàm không tồn tại).

4. **Cache:** Kết quả được lưu vào `.cleak/allocator-profile.json` trong thư mục dự án. Lần scan sau không cần gọi LLM lại.

Trong thực nghiệm trên cJSON (mimo/mimo-v2.5-pro, temperature 0), allocator profiling đạt: Allocator Recall 85%, Deallocator Recall 100%. LLM phát hiện nhiều allocator hơn list hardcode — cụ thể `cJSON_Parse()` và `cJSON_Print()` trả về owned memory mà hardcoded set bỏ sót.

### 3.7.2. Strategist

`strategist.ts` implement adaptive planning — LLM đọc metadata dự án và quyết định chiến lược phân tích. Bước đầu, `gatherRepoMetadata()` thu thập thông tin deterministic (không cần LLM): số file, tỉ lệ C++, build system nào (`CMakeLists.txt`, `Makefile`, `meson.build`...), và mật độ smart pointer (unique_ptr, shared_ptr, g_object_ref...).

Metadata + allocator profile được gửi cho model, yêu cầu trả về:
```typescript
const StrategyPlanSchema = z.object({
  runDynamic: z.boolean(),    // có chạy sanitizer không
  judge: z.enum(['single', 'consensus']),  // single LLM hay consensus
  staticDepth: z.enum(['shallow', 'full']),  // phân tích tĩnh nông hay sâu
});
```

Đây là module OPT-IN (`--strategy auto`). Trong benchmark, strategist bị bypass — config explicit được dùng để đảm bảo reproducibility.

### 3.7.3. Judge tuner

`judgeTuner.ts` cho phép LLM đề xuất ngưỡng phán xét phù hợp với dự án. Ví dụ: dự án dùng nhiều RAII/smart pointer → nâng ngưỡng confirmed lên (giảm FP); dự án manual malloc/free lộn xộn → hạ ngưỡng xuống (tăng recall).

Điểm mấu chốt: ngưỡng bị **clamp** cứng — confirmed nằm trong [0.55, 0.85], likely trong [0.25, 0.6], và confirmed luôn > likely. LLM không thể làm judge quá nhạy (ngưỡng thấp) hay quá bảo thủ (ngưỡng cao). Trong benchmark, tuner cũng bị bypass — frozen defaults luôn được dùng.

---

## 3.8. Triển khai và vận hành

### 3.8.1. Docker Compose

Hai analyzer service được deploy qua Docker Compose:

```yaml
services:
  static-analyzer:
    ports: ["127.0.0.1:50061:50061"]
    volumes: ["./demo:/workspace/demo", "./targets:/workspace/targets"]
    networks: [mcpvul-net]

  dynamic-analyzer:
    ports: ["127.0.0.1:50062:50062"]
    volumes: ["runs:/runs", "./demo:/workspace/demo", "./targets:/workspace/targets"]
    networks: [mcpvul-net]
```

Port chỉ bind `127.0.0.1` — đây là dịch vụ nội bộ, không authenticated, không nên expose ra LAN. Dynamic analyzer có thêm named volume `runs` để persist analysis artifacts giữa các container restart.

Mỗi container đọc env từ `apps/<svc>/.env` (optional — boots với defaults nếu file không tồn tại). Docker image bake sẵn `clang` và `clang-tools-extra` (cho scan-build) vào static-analyzer image.

### 3.8.2. LLM gateway

Thực nghiệm sử dụng local LLM gateway tại `http://localhost:20128/v1` với model `mimo/mimo-v2.5-pro`. Gateway tuân thủ OpenAI Chat Completions API — nên hệ thống dùng provider `local` (thực chất là OpenAI-compatible endpoint). Temperature mặc định: 0 (judge single), 0.7 (consensus sample).

### 3.8.3. Configuration hierarchy

Hệ thống hỗ trợ 4 nguồn config, theo thứ tự ưu tiên giảm dần:

1. **CLI flags:** `--provider`, `--max-turns`, `--consensus-n`, v.v.
2. **Environment variables:** `PROVIDER`, `MAX_TURNS`, `STATIC_URL`, v.v.
3. **Config file:** `~/.config/cleak/config.json` — Zod-validated, chmod 600 (vì chứa API key).
4. **Built-in defaults:** Xem `configTemplate()` — ví dụ `maxTurns: 15`, `staticConcurrency: 3`, `staticGroupSize: 4`.

Config file được validate bằng Zod lenient parse — mỗi key được validate độc lập, key invalid bị bỏ qua với warning trên stderr thay vì reject toàn bộ file.

### 3.8.4. Corpus pipeline

Quản lý corpus đánh giá là một pipeline riêng, gồm 4 bước:

1. **Ingest:** `corpus/juliet/ingest.ts` copy file từ NIST Juliet Test Suite v1.3, group C++ multi-file cases, derive label từ convention `*bad*`/`*good*` trong tên file. `corpus/lamed/ingest.ts` clone repo từ Zenodo tại bug commit cụ thể.

2. **Validate:** `validate-corpus.ts` chạy 5 gates:
   - Gate 1: Zod schema validation (manifest format đúng)
   - Gate 2: Structural check (file tồn tại, không rỗng)
   - Gate 3: Compile check (`clang -fsyntax-only` pass)
   - Gate 4: Label overlap detection (không có file vừa bad vừa good)
   - Gate 5: Content-hash integrity

3. **Lock:** Tạo `<corpus>.lock.json` với source hash, ingest commit, clang version — đảm bảo reproducibility.

4. **Eval gate:** Chạy evaluation chỉ trên corpus đã validated + locked.

---

## 3.9. Tổng kết chương

Chương này đã trình bày chi tiết quá trình hiện thực hoá hệ thống từ thiết kế sang code. Một số điểm đáng chú ý:

Thứ nhất, quyết định viết toàn bộ hệ thống bằng TypeScript — thay vì C++ hay Python — xuất phát từ ràng buộc thực tế: MCP SDK chỉ có bản TypeScript, và orchestrator không cần hiệu năng tính toán cao (phần nặng nhất — parsing AST — đã do tree-sitter C library xử lý).

Thứ hai, cơ chế threading `extraAllocators`/`extraDeallocators` xuyên suốt 7 static tools là thay đổi có impact lớn nhất trong quá trình phát triển. Trước khi có cơ chế này, hệ thống hoàn toàn blind với non-libc allocator — dẫn đến 0% recall trên LAMeD benchmark (dự án thực không dùng malloc trực tiếp). Sau khi threading, recall trên LAMeD tăng từ 0/41 lên 12/41.

Thứ ba, deterministic evidence capture (Stage B wrapper) là yếu tố then chốt cho reproducibility. Bằng cách loại bỏ LLM discretion khỏi quá trình ghi nhận finding, hệ thống đảm bảo rằng cùng một sanitizer run luôn produce cùng một evidence — dù LLM quyết định tool nào gọi.

Phần tiếp theo (Chương 4) sẽ đánh giá hệ thống đã cài đặt này trên hai corpus (Juliet 1658 ca và LAMeD 41 ca), so sánh với Clang Static Analyzer, và phân tích đóng góp của từng thành phần qua ablation study.
