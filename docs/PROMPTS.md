# Danh mục Prompt LLM (leak-inspector-tui)

> Tài liệu này tổng hợp **mọi prompt / instruction text** mà hệ thống gửi cho LLM trong
> đường (path) **`leak-inspector-tui`** — đường điều phối **native tool-calling** đang chạy
> thật: system prompt, user message, **mô tả tool** (với native tool-calling, phần
> `description` của mỗi tool cũng đi vào schema gửi cho model), và các *notice* được chèn vào
> hội thoại. Phần diễn giải bằng tiếng Việt; **prompt gốc giữ nguyên văn tiếng Anh** đúng như
> trong source. Mỗi mục ghi rõ `file:dòng` — **source code mới là nguồn chân lý**, nếu sửa
> prompt hãy cập nhật cả file này.
>
> **Phạm vi:** chỉ tài liệu hoá path TUI. Đường web (`control-plane`, JSON-action
> orchestrator) **đã được gỡ khỏi hệ thống** nên không còn ở đây.
>
> Xem thêm: [ARCHITECTURE.md](./ARCHITECTURE.md) · [EVALUATION.md](./EVALUATION.md) ·
> [sequence-diagrams.md](./sequence-diagrams.md)

---

## 0. Tổng quan — pipeline 4 tầng và nơi LLM được gọi

Path TUI **không** phải một agent tự do gọi mọi tool. Nó là một **workflow đa-agent theo
tầng**, định nghĩa ở `apps/leak-inspector-tui/src/orchestrator/workflowInvestigation.ts`.

LLM được gọi ở hai nơi: (1) **tầng POLICY host-side** TRƯỚC pipeline (3 prompt one-shot:
allocator-profiler, strategist, judge-tuner — xem §0.5), và (2) **investigation 4-tầng** (Stage A,
Stage B-khi-cần, Stage D). Stage C + hợp nhất bằng chứng là **tất định, không LLM**. Mọi prompt POLICY
là one-shot temp-0, output **verify (grep/clamp) + cache**, và **bỏ qua trong benchmark** (manifest đông
cứng) ⇒ eval tất định.

| Tầng | Việc | LLM? | Prompt |
|---|---|---|---|
| **A · Static fan-out** | nhiều **static sub-agent**, mỗi cái nhận một nhóm candidate, chạy tool tĩnh để **gom bằng chứng** — **không ra verdict** | ✅ | `staticSubAgentSystemPrompt` |
| **B · Dynamic** | nếu biết `buildCommand` → **công thức tất định, KHÔNG LLM** (`buildTarget → lsanRun`); nếu không → **1 dynamic worker (LLM)** build + chạy sanitizer | ⚙️/✅ | `dynamicWorkerSystemPrompt` |
| **C · Synthesize** | hợp nhất static context + dynamic evidence, đóng dấu coverage | ❌ | — |
| **D · Hybrid judge** | heuristic (tất định) cho **mọi** bundle; **LLM judge** chỉ cho bundle **borderline**; **consensus** (k mẫu) tuỳ chọn | ✅ | `llmJudge` SYSTEM_PROMPT |

Đặc điểm cốt lõi:
- **Phân vùng tool cứng:** static sub-agent chỉ nhận tool tĩnh; dynamic worker chỉ nhận tool
  động → LLM **không thể nhảy chéo** static↔dynamic. Thứ tự A–B chạy **song song**
  (`Promise.all`, `workflowInvestigation.ts:282`).
- **Bằng chứng được capture TỰ ĐỘNG:** static context và dynamic finding do code bắt
  (`withStaticContextCapture` / `withDynamicEvidenceCapture`), model **không** tự ghi.
- **Verdict do code ghi**, không qua LLM tool-call. Mọi lỗi gọi/parse model ở bất kỳ tầng nào
  → **rớt về heuristic** (an toàn, không tệ hơn).
- **Cờ `toolSelect`** (`opts.toolSelect`, mặc định `true`): khi `false`, Stage A bỏ qua agentic
  sub-agent, chỉ chạy deterministic enrichment (stage `enrich` của `scanController`); Stage B
  chạy deterministic recipe (nếu có) hoặc skip — không có LLM worker fallback. Stage D vẫn chạy
  LLM judge cho borderline (độc lập với toolSelect).
- **Cờ `dynamicAlreadyRan`** (`ctx.dynamicAlreadyRan`): khi dynamic-only discovery đã chạy
  trước (static=false, dynamic selective/aggressive), Stage B bỏ qua vì bằng chứng động đã
  được gắn vào bundle.

**Provider dispatch** — `packages/agent-core/src/providers/index.ts:23-31`: `provider ===
'anthropic'` → `callAnthropic`, còn lại (`local` / `openai` / `openai-compat`) →
`callOpenAiChat`. Cách giao system prompt: Anthropic đặt ở tham số top-level `system`
(`providers/anthropic.ts:29`); OpenAI-compatible chèn làm message đầu `{role:'system',
content}` (`providers/normalize.ts:41`). Mặc định thesis: gateway OpenAI-compatible nội bộ
`local`, model `mimo/mimo-v2.5-pro` tại `localhost:20128/v1` (host-aware) — `config.ts:105-166`.

---

## 0.5. Tầng POLICY (host-side, one-shot, TRƯỚC investigation)

Ba prompt khám-phá-theo-project, đều: *gather host-side → one-shot `callModel` (temp 0) → parse Zod
lenient (kiểu `parseVerdict`) → **verify** → cache `<repo>/.cleak/`*. Resolve ở `surfaces/headless.ts`.
**Bỏ qua khi allocators được cấp tường minh** (eval) ⇒ tất định.

### 0.5.1. Allocator profiler — `allocatorProfileSystemPrompt`

- **File:** `apps/leak-inspector-tui/src/domain/allocatorProfiler.ts:90-103`

Đọc header (đầy đủ) + source (cắt) → liệt kê **API cấp phát/giải phóng custom** của project (factory
`*_new/*_create/*_dup`, parser/printer trả owned, macro `#define ALLOC`, smart-ptr `make_unique`) +
`ownershipNotes` (quy ước sở hữu: transfer/borrow/refcount/pool, "Delete bỏ qua const"…). Output JSON
`{allocators, deallocators, reallocators, ownershipNotes, confidence, explanation}`. **Verify:** chỉ giữ
tên là identifier hợp lệ, KHÔNG phải libc, và **thực sự xuất hiện** trong source đã đưa cho model
(`verifyNames`, chống hallucinate). Đo độ chính xác bằng `scripts/validate-allocator-profile.ts` (P/R/F1
so ground-truth). → nạp `extraAllocators/Deallocators` + `ownershipNotes`.

```text
You are a C/C++ memory-management API analyst. Given header/source excerpts from ONE project, identify that project's CUSTOM allocation and deallocation functions — the wrappers/replacements for malloc/free: factory constructors and duplicators (`*_new`, `*_create*`, `*_alloc*`, `*_dup`, `*_clone`, `*_copy` that return owned memory) and their matching releases (`*_free`, `*_delete`, `*_destroy`, `*_release`, `*_unref`, `*_close`, pool/arena destructors) — plus any ownership conventions a leak checker must know.
Respond with a JSON object ONLY (no prose), in this exact shape:
{"allocators":["..."],"deallocators":["..."],"reallocators":["..."],"ownershipNotes":["..."],"confidence":0.0-1.0,"explanation":"..."}
Rules:
- Be EXHAUSTIVE on allocators: list EVERY function that returns newly-owned memory — ALL constructors/factories (`*_New*`, `*_Create*`), duplicators (`*_Duplicate`, `*_dup`, `*_clone`, `*_copy`), and parsers/printers/serializers that return an owned buffer (`*_Parse*`, `*_Print*`). Do not stop at a few examples — include the whole family even if it is long.
- Use EXACT function names as they appear in the code.
- Include INTERNAL/static helpers too (e.g. a static `cJSON_malloc`/`*_New_Item` wrapper, a private `*_strdup`), not only the public API — leaks often flow through them.
- Include MACRO allocators/deallocators: a `#define MY_ALLOC(n) malloc(n)` (or `#define FREE_OBJ(p) ...`) is an allocator/deallocator named `MY_ALLOC`/`FREE_OBJ` — list the macro name.
- Do NOT include plain libc malloc/calloc/realloc/free/strdup — the engine already knows those. Only the project's CUSTOM names.
- allocators/reallocators RETURN newly-owned heap memory the caller is responsible for; deallocators FREE or consume it.
- ownershipNotes: short, project-specific rules (transfer vs borrow, refcounting, pool/arena "free the pool, not each object", "X skips items flagged Y", a constructor that steals its argument). Empty array if none.
- Precision over recall: if unsure a name is an allocator/deallocator, OMIT it.
```

### 0.5.2. Strategist — `strategistSystemPrompt`

- **File:** `apps/leak-inspector-tui/src/domain/strategist.ts:72-80`

Đọc metadata repo (số file, tỉ lệ C++, có build-system?, mật độ smart-ptr) + tóm tắt profile → chọn
`{runDynamic, judge: single|consensus, staticDepth: shallow|full}`. v0 wire `runDynamic` (bỏ stage dynamic
khi không build được). **Fallback rule-based tất định** khi LLM lỗi. OPT-IN `--strategy auto`.

```text
You are the STRATEGIST for a C/C++ memory-leak analyzer. Given a project's metadata + memory-API profile, choose an analysis plan by SELECTING among the engine's existing deterministic capabilities — you do not invent analysis. Respond with a JSON object ONLY:
{"runDynamic": true|false, "judge": "single"|"consensus", "staticDepth": "shallow"|"full", "rationale": "..."}
Guidance:
- runDynamic: run sanitizer (LeakSanitizer) dynamic analysis ONLY if the project is plausibly buildable (a build system is present) AND dynamic coverage would help. If there is NO build system, set false — building is impossible, so skip the expensive dynamic stage (no recall lost).
- judge: "consensus" (slower, more robust) for projects whose ownership is subtle — heavy smart-pointer / refcounting / C++; else "single".
- staticDepth: "shallow" (function summaries only) for tiny or trivial projects; "full" (path constraints + ownership + interprocedural) for larger or control-flow-heavy ones.
Be decisive; prefer cheaper plans when they lose no recall.
```

### 0.5.3. Judge tuner — `judgeTunerSystemPrompt`

- **File:** `apps/leak-inspector-tui/src/domain/judgeTuner.ts:51-56`

Từ profile → nudge ngưỡng verdict `{confirmed, likely}` cho hợp memory-style project. **Clamp cứng**
(confirmed 0.55–0.85, likely 0.25–0.6, confirmed>likely) ⇒ LLM không thể làm judge liều. **Production-only**
— eval LUÔN dùng ngưỡng đông cứng `JUDGE_VERDICT_THRESHOLDS`.

```text
You calibrate a C/C++ leak judge's verdict thresholds for ONE project. The judge scores each candidate in [0,1]; score ≥ confirmed → confirmed_leak, ≥ likely → likely_leak, else uncertain.
Defaults: confirmed=0.7, likely=0.4.
Nudge them to fit the project's memory style, staying near the defaults. Respond with JSON ONLY: {"confirmed": 0.55-0.85, "likely": 0.25-0.6, "rationale": "..."}.
Heuristics: heavy smart-pointer/RAII or refcounting (false positives likely) → RAISE confirmed slightly; a project with many obvious manual malloc/free and missing frees → LOWER thresholds slightly to catch more. Keep confirmed > likely. Small moves only.
```

---

## 1. Stage A — Static sub-agent

Mỗi nhóm candidate (gom theo *file affinity*, `staticGroupSize=4`) sinh một sub-agent với
context nhỏ + bộ tool tĩnh giới hạn. Sub-agent chạy tới khi mọi candidate trong nhóm có
static context rồi gọi `${DONE_STATIC}`.

### 1.1. System prompt — `staticSubAgentSystemPrompt(repoPath)`

- **File:** `apps/leak-inspector-tui/src/domain/subAgentPrompts.ts:39-54`
- **Biến nội suy:** `${repoPath}`.

```text
You are a STATIC-ANALYSIS evidence-gathering sub-agent for C/C++ memory leaks.
You do NOT record verdicts — your only job is to RUN the static tools so the system can collect structured evidence for each candidate, then call `${DONE_STATIC}`.

For EACH candidate in your list, gather evidence:
- `functionSummary` (filePath, functionName) — alloc/free balance + leaky exit paths.
- `pathConstraints` (filePath, lineNumber of the allocation) — feasible leaking paths.
- `astScan` (filePath) — structural patterns + early returns.
- `ownershipConventions` (filePath) — ownership-transfer / missing-free conventions.
- `read_file` to inspect the source and, for interprocedural cases (a function returning an allocation), follow the caller.

Efficiency: you MAY call several of these read-only tools in a SINGLE turn — they run in parallel. The repository root is ${repoPath}.
When you have run the static tools for EVERY candidate in your list, call `${DONE_STATIC}`. Do NOT reply with prose — only tool calls advance the work.
```

### 1.2. User message — `staticSubAgentUserMessage(bundles)`

- **File:** `subAgentPrompts.ts:56-63` (mỗi candidate theo `candidateList`, `:28-35`).

```text
Gather static evidence for these ${N} candidate allocation site(s):
- ${bundleId} — ${function}() at ${file}:${line} (${allocation_type})
…

Run the static tools for each, then call ${DONE_STATIC}.
```

### 1.3. Tool phát cho model (Stage A)

`workflowInvestigation.ts:199-203`. Mô tả từng tool xem [§5](#5-mô-tả-tool-gửi-cho-model).
- **5 tool tĩnh content-capable**: `candidateScan`, `astScan`, `functionSummary`,
  `pathConstraints`, `ownershipConventions` — đây là **toàn bộ** tool tĩnh được phơi ra cho
  model (lọc bởi `CONTENT_CAPABLE_TOOLS`, `mcpToolPlan.ts:103-109`). 6 tool tĩnh còn lại
  (`indexFiles`, `callGraph`, `interproceduralFlow`, `ownershipSummary`, `scanBuildRun`,
  `scanBuildGetReport`) **bị loại** vì cần mount filesystem chung → giữ analyzer stateless,
  deploy được từ xa.
- `read_file` (xem [§5](#read_file--done-tool)).
- `done_static` — terminal tool kết thúc vòng lặp.

### 1.4. Completion nudge (chèn làm user message khi model định dừng sớm)

- **File:** `workflowInvestigation.ts:211-216` (guard `checkCompletion`, gọi từ
  `agent-core/loop.ts:168-177`, tối đa `maxStopNudges`).

```text
You stopped, but ${N} candidate(s) have NO static evidence yet: ${ids}. Run functionSummary/pathConstraints/astScan/ownershipConventions for them, then call ${DONE_STATIC}. Only tool calls advance the work.
```

---

## 2. Stage B — Dynamic worker

Chạy **song song** với Stage A. Chỉ bật khi `dynamicMode ≠ off` **và** có `dynamicClient`
(`workflowInvestigation.ts:127`). Có **hai nhánh**:

### 2.1. Nhánh tất định (KHÔNG LLM) — `runDeterministicDynamic`

- **File:** `apps/leak-inspector-tui/src/domain/dynamicEvidence.ts:234-274`.
- Khi case mang sẵn `buildCommand` (vd quy ước Juliet `make CC=clang CXX=clang++`), Stage B
  chạy **công thức cố định** `buildTarget(buildCommand) → lsanRun(a.out)` — **không prompt
  LLM** — để run (và do đó coverage/verdict) tái lập được. Chỉ rớt sang worker LLM khi build
  thất bại hoặc không có `buildCommand`.
- **Notice:** `Stage B · dynamic evidence: deterministic recipe (buildTarget → lsanRun, no LLM)`
  (`:236`); nếu hỏng: `Stage B · deterministic recipe produced no run — falling back to the LLM worker` (`:251`).
- Khi `toolSelect=false`, nhánh deterministic recipe skip worker LLM: `Stage B · deterministic recipe produced no run — tool_selector off, skipping LLM worker` (`:248-249`).

### 2.2. System prompt — `dynamicWorkerSystemPrompt(repoPath, buildCommand?)`

- **File:** `subAgentPrompts.ts:67-78`
- **Biến nội suy:** `${repoPath}`; dòng `A hint build command was provided: …` **chỉ** xuất
  hiện khi có `buildCommand`.

```text
You are a DYNAMIC-ANALYSIS sub-agent for C/C++ memory leaks. Build the project ONCE with a sanitizer, run it under a sanitizer, then call `${DONE_DYNAMIC}`.

1. `read_file` the Makefile / CMakeLists.txt / build script under ${repoPath} to learn how it builds. A hint build command was provided: `${buildCommand}`.
2. `buildTarget` (projectPath=${repoPath}, buildCommand = a clang command with sanitizer flags). Prefer LeakSanitizer (`-fsanitize=leak -g -O0`) — it reports at exit and never aborts mid-run.
3. Run the binary with `lsanRun` (or `asanRun` / `valgrindMemcheck`).

The system CAPTURES every finding from your sanitizer runs AUTOMATICALLY and attaches it to the matching candidate — you do NOT record evidence yourself. Your only job is to get a successful sanitizer run.
Build at most ONCE and run each dynamic tool at most once. If a build or sanitizer fails twice, stop and call `${DONE_DYNAMIC}`. When a sanitizer has run, call `${DONE_DYNAMIC}`. Do NOT reply with prose.
```

> Đây chính là chỗ "model biết lệnh build": worker **tự `read_file` Makefile/CMake** rồi tự
> chọn lệnh `buildTarget` clang+sanitizer; `buildCommand` discovery chỉ là **gợi ý**.

### 2.3. User message — `dynamicWorkerUserMessage(bundles)`

- **File:** `subAgentPrompts.ts:80-90` (liệt kê tối đa 100 candidate).

```text
Run a sanitizer once over the build that covers these ${N} candidate(s):
- ${bundleId} — ${function}() at ${file}:${line} (${allocation_type})
…
… and ${N-100} more.        # chỉ khi N > 100

Build once, run a sanitizer (the system captures the findings), then call ${DONE_DYNAMIC}.
```

### 2.4. Tool phát cho model (Stage B)

`workflowInvestigation.ts:262-266`: **9 tool động** (xem [§5](#dynamic-analyzer-9-tool)) bọc
trong `withDynamicEvidenceCapture` (finding được bắt tự động — `record_evidence` **cố tình
không** có trong toolset) + `read_file` + `done_dynamic`. `maxTurns` của worker = `maxTurns + 10`.

### 2.5. Completion nudge

- **File:** `workflowInvestigation.ts:275-278` (không cho worker dừng trước khi có một
  sanitizer run thành công).

```text
No successful sanitizer run yet. buildTarget (with a sanitizer flag), then run lsanRun/asanRun/valgrindMemcheck, then call ${DONE_DYNAMIC}. Only tool calls advance the work.
```

---

## 3. Stage D — Judge (LLM, chỉ cho bundle borderline)

Heuristic chấm **mọi** bundle trước (`heuristicVerdict`, `workflowInvestigation.ts:299-303`).
Chỉ những bundle **borderline / mâu thuẫn** mới được đẩy lên LLM; phần còn lại giữ verdict
heuristic.

### 3.1. Cổng leo thang — bundle nào lên LLM

- **`isBorderline`** — `apps/leak-inspector-tui/src/domain/llmJudge.ts:238-243`: verdict
  `likely_leak`/`uncertain`, **hoặc** `confidence ∈ [0.35, 0.7]`.
- **`shouldEscalate`** — `llmJudge.ts:256-287`: `isBorderline`, **hoặc** mâu thuẫn
  static↔verdict / dynamic↔verdict (vd cờ leak nhưng dynamic chạy sạch; không cờ nhưng có
  runtime leak tương quan; verdict nghịch `deriveFusion`). Đây là chỗ tái-kích-hoạt consensus
  khi nó cần nhất.

### 3.2. System prompt — `SYSTEM_PROMPT`

- **File:** `llmJudge.ts` (`SYSTEM_PROMPT`)
- **Định dạng output:** **JSON only** (không native tool-calling; `tools: []`).

```text
You are an expert C/C++ memory-leak analyst. Decide whether ONE allocation is a real leak, using the code, static context, and any runtime evidence provided.
Respond with a JSON object ONLY (no prose), in this exact shape:
{"verdict": "confirmed_leak | likely_leak | uncertain | likely_false_positive | false_positive", "confidence": 0.0-1.0, "explanation": "...", "evidence": ["..."]}
Calibrate using the EVIDENCE, in this priority order:
- A runtime leak (sanitizer/valgrind) whose allocation site is LINKED to this candidate is decisive → confirmed_leak (confidence ≥ 0.9). Weight by leak kind: definitely_lost / asan_leak ⇒ decisive; possibly_lost ⇒ weak corroboration; still_reachable ⇒ usually benign, lean false_positive.
- A runtime finding in the SAME FILE but a DIFFERENT site (not linked) is weak — do not treat it as proof for this allocation. still_reachable with no other evidence → false_positive.
- A CLEAN sanitizer/valgrind run that EXERCISED this allocation and reported NO leak here is strong evidence this is NOT a leak → lean false_positive / likely_false_positive (unless a runtime leak is LINKED to this very allocation).
- Ownership is decisive for false positives: if the allocation is RETURNED to the caller or its pointer is HANDED OFF to a sink/callback/another function (ownership transferred), freeing it is NOT this function's job. When ownership is transferred AND no runtime leak is linked to THIS allocation, answer likely_false_positive or false_positive — do NOT flag it just because you cannot see the free inside this snippet. An UNPAIRED alloc→free with a reachable leak path and NO ownership transfer → confirmed_leak (≥ 0.85).
- PATH-SENSITIVE leak: an allocation freed on the main/success path but NOT on an error or early-return path (e.g. `if (err) return NULL;` or `goto fail;` before the free) IS a leak — confirmed_leak — EVEN IF the value is returned or added to a structure on the success path. Ownership transferring on success does not cover the error path that loses the object. If the static context lists the allocation as freed "on some paths only" (conditional) or names it on a reachable un-freed exit path, treat that as decisive.
- PARAMETER-ownership leak (allocation_type 'parameter_ownership'): when a function frees a pointer PARAMETER on some paths (taking ownership from the caller, e.g. cJSON's `merge_patch` does `cJSON_Delete(target)`) but a reachable branch returns WITHOUT freeing it, that branch leaks the parameter — confirmed_leak. The parameter has no allocation site in the function; judge it by the conditional free + the reachable un-freed exit.
- Freed on all paths / static-global → false_positive (high confidence). Use uncertain only when the evidence is genuinely insufficient.
- Control flow is concrete, not hypothetical: a constant or scaffolding global such as `if(1)`/`if(0)` or `globalReturnsTrue()` does NOT change between two checks in the SAME function — `if(1)` always runs and `if(0)` is dead code. If the buffer is freed under the same condition it was allocated (or in the `else` of a constant `if`), it IS freed. Do NOT call a leak just because the `free()` sits in a different block, behind a constant condition, or after a `break`/in a second loop — trace whether it actually executes.
```

> **Thay đổi so với phiên bản đầu:** 2 câu được thêm vào SYSTEM_PROMPT:
> (1) Cuối bullet PATH-SENSITIVE: "Ownership transferring on success does not cover the error path that loses the object." — nhấn mạnh rằng ownership transfer chỉ bao phủ success path, không bao phủ error path làm mất object.
> (2) Bullet PARAMETER-ownership được mở rộng với "The parameter has no allocation site in the function; judge it by the conditional free + the reachable un-freed exit." — làm rõ rằng parameter không có allocation site trong function, judge dựa trên conditional free + reachable un-freed exit.

### 3.3. User message

- **File:** `llmJudge.ts:193-211`. `${sourceSnippet}` = **toàn bộ hàm bao** quanh allocation
  (đã **xoá comment** để không lộ nhãn benchmark; cửa sổ dự phòng ±(6,5) dòng,
  `judge-shared.ts:95`). `${summarizeStatic}` (`:48-91`) và `${summarizeEvidence}` (`:93-113`)
  dựng từ static context / dynamic evidence.

```text
ALLOCATION SITE: ${function}() at ${file}:${line} (${allocation_type})

CODE (context around the allocation):
```c
${sourceSnippet}
```

STATIC ANALYSIS CONTEXT:
${summarizeStatic}        # Ownership · Alloc→free pairing · Feasible leak paths (hoặc fallback đếm alloc/free/early-return)

DYNAMIC EVIDENCE (${N}):
${summarizeEvidence}      # mỗi finding: tool:kind bytes/blocks @ site [LINKED | same file, different site | CLEAN]; hoặc "(none)"

PROJECT OWNERSHIP CONVENTIONS (respect these — they encode how THIS project manages memory):   # CHỈ khi có — ownershipNotes do allocator-profiler (§0.5.1) khám phá
- <vd: "cJSON_Delete bỏ qua chuỗi gắn cJSON_StringIsConst"; "cJSON_Add*ToObject chuyển sở hữu cho parent">

Return your JSON verdict.
```

### 3.4. Parse + làm giàu

`parseVerdict` (`llmJudge.ts:136-169`): `JSON.parse`, fallback regex `/\{[\s\S]*\}/`; chỉ nhận
nếu `verdict` là 1 trong 5 nhãn hợp lệ (`isLeakVerdictString`), `confidence` clamp `[0,1]`;
hỏng → `null` → giữ verdict heuristic. Verdict hợp lệ chạy qua `enrichLeakVerdict`
(`@cleak/common/analysis/heuristic-judge`) để gắn `rootCause` + repair diff source-anchored.

---

## 4. Consensus judge (tuỳ chọn — đóng góp luận văn)

Bật khi `CONSENSUS_N > 1`. **Không có prompt riêng** — `judgeByConsensus`
(`packages/common/src/analysis/consensus-judge.ts:258-269`) lấy mẫu **chính
`judgeBundleWithLlm`** N lần ở `CONSENSUS_TEMPERATURE` (do đó **tái dùng y nguyên** SYSTEM_PROMPT
§3.2), nối tại `workflowInvestigation.ts:316-349`. `combineVerdicts` (`:151-226`) gộp N nhãn
thành 1 cờ flag theo luật, rồi chọn nhãn modal trong cụm đồng thuận (xem [§8](#8-ranh-giới-quyết-định-decision-boundaries) cho con số).

---

## 5. Mô tả tool gửi cho model

Với native tool-calling, `description` của mỗi tool đi vào schema model thấy. Tool MCP được
nạp qua `loadMcpTools` → `wrapMcpTool` (`agent-core/src/mcp/mcpToolAdapter.ts:39-42`): giữ
nguyên `description` và `inputSchema` của tool từ xa. Chính sách thực thi
(`mcpToolPlan.ts:45-56`): tool truy vấn thuần (`CONCURRENCY_SAFE`) read-only + song song,
timeout 30s; tool nặng (`SERIAL_HEAVY`: build/sanitizer/scan-build) read-only + **tuần tự** +
**cần phê duyệt (`ask`)**, timeout 300s.

### Static analyzer (11 tool) — `apps/static-analyzer/src/mcp/static-mcp-server.ts:38-127`

| Tool | `description` (verbatim) | Phơi cho TUI? |
|---|---|---|
| `candidateScan` | *Scan a file for allocation sites (malloc, calloc, realloc, strdup, new). Optionally supply per-project factory allocators / custom deallocators (≈ LAMeD AllocSource/FreeSink) so wrapper-named allocators (e.g. cJSON_Duplicate) become candidates.* | ✅ |
| `astScan` | *AST-based structural analysis for memory leak patterns* | ✅ |
| `functionSummary` | *Summarize a function: alloc/free balance, local vars, calls. Optionally supply per-project allocators/deallocators so factory-allocated vars are paired.* | ✅ |
| `pathConstraints` | *Analyze path constraints and feasible paths around an allocation. Optionally supply per-project allocators/deallocators so factory allocations are tracked on exit paths.* | ✅ |
| `ownershipConventions` | *Detect ownership-transfer conventions in a file* | ✅ |
| `indexFiles` | *Index all C/C++ source files recursively from a root path* | ❌ |
| `callGraph` | *Extract call graph edges and nodes. Optionally supply per-project allocators/deallocators so the alloc→free reachability chains track factory allocators.* | ❌ |
| `interproceduralFlow` | *Interprocedural alloc/free flow tracing for a function. Optionally supply per-project allocators/deallocators so the trace tracks factory allocators (cJSON_malloc/_TIFFfree/…) — without them it is blind to non-libc memory APIs.* | ❌ |
| `ownershipSummary` | *Summarize ownership conventions across files* | ❌ |
| `scanBuildRun` | *Run the project-level Clang Static Analyzer (scan-build) over the project build* | ❌ |
| `scanBuildGetReport` | *Retrieve Clang Static Analyzer (scan-build) findings* | ❌ |

> ❌ = bị loại khỏi TUI (cần filesystem mount chung) — `CONTENT_CAPABLE_TOOLS`,
> `mcpToolPlan.ts:103-109`. Slot `scanBuild*` nay là Clang Static Analyzer (scan-build)
> self-contained.
>
> **Thay đổi so với bản cũ:** 5 tool — candidateScan, callGraph, functionSummary, interproceduralFlow, pathConstraints — đã được thêm mô tả về extraAllocators/extraDeallocators (≈ LAMeD AllocSource/FreeSink) để engine tất định nhận diện allocator wrapper theo dự án.

### Dynamic analyzer (9 tool) — `apps/dynamic-analyzer/src/mcp/dynamic-mcp-server.ts:41-93`

| Tool | `description` (verbatim) |
|---|---|
| `buildTarget` | *Build the project with sanitizer-instrumented compiler flags* |
| `valgrindMemcheck` | *Run Valgrind Memcheck for detailed leak analysis* |
| `valgrindGetReport` | *Retrieve a normalized Valgrind report* |
| `valgrindListFindings` | *Query Valgrind findings with optional filters* |
| `valgrindCompareRuns` | *Compare two Valgrind analysis runs* |
| `asanRun` | *Run the binary under AddressSanitizer for leak detection* |
| `lsanRun` | *Run the binary under LeakSanitizer* |
| `runBinary` | *Run a binary without instrumentation* |
| `listRuns` | *List stored dynamic analysis runs* |

### `read_file` + done tool

| Tool | `description` (verbatim) | File |
|---|---|---|
| `read_file` | *Read a source file from the repository (path relative to the repo root, or an absolute path inside it). Returns up to 16000 characters.* | `apps/leak-inspector-tui/src/domain/readFileTool.ts:17-43` |
| `done_static` | *Finish static evidence gathering for this group of candidates.* | `workflowInvestigation.ts:202` |
| `done_dynamic` | *Finish dynamic evidence collection.* | `workflowInvestigation.ts:265` |

> `read_file` là **tool domain duy nhất** còn dùng. `buildDoneTool` định nghĩa ở
> `subAgentPrompts.ts:17-26` (no-op, `{done:true}`).

---

## 6. Notice / placeholder (agent-core — chèn vào hội thoại / hiển thị)

- **Compaction notice** — `packages/agent-core/src/loop.ts:103`:
  ```text
  Compacted context: pruned ~${tokens} tokens of stale tool output
  ```
- **Stop-nudge notice** — `loop.ts:174` (khi model dừng sớm mà `checkCompletion` còn việc):
  ```text
  Agent stopped early — nudging to finish (${stopNudges}/${maxStopNudges})
  ```
- **Placeholder thay tool-result cũ khi nén context** — `packages/agent-core/src/compaction.ts:66`
  (prefix `[elided:`, `:17`):
  ```text
  [elided: ${n} chars of stale tool output pruned to save context]
  ```
- **Stage notice** (hiển thị tiến trình, `workflowInvestigation.ts`): `Stage A · static
  evidence: …` (`:191`), `Stage B · …` (`:225,236,248,251,257`), `Stage C · synthesize: …`
  (`:296`), `Stage D · judge: …` (`:299,309`).

---

## 7. Tham số điều khiển vòng lặp / judge — `apps/leak-inspector-tui/src/config.ts`

| Tham số | Mặc định | Env | Dòng |
|---|---|---|---|
| Turn tối đa mỗi sub-agent | `15` (dynamic worker `+10`) | `AGENT_MAX_TURNS` | `:183` |
| Idle-timeout stream | `75000` ms | `LLM_IDLE_TIMEOUT_MS` (fallback `LLM_TIMEOUT_MS`) | `:111` |
| `maxStopNudges` | `3` | — | `agent-core/loop.ts` |
| Consensus N | `1` (opt-in 3/5 cho ablation) | `CONSENSUS_N` | `:196` |
| Consensus rule | `weighted` (`majority`/`weighted`/`unanimous-to-flag`) | `CONSENSUS_RULE` | `:197` |
| Consensus temperature | `0.7` | `CONSENSUS_TEMPERATURE` | `:199` |
| Consensus concurrency | `3` | `CONSENSUS_CONCURRENCY` | `:200` |
| Judge temperature (single) | `0` | `JUDGE_LLM_TEMPERATURE` | `:118` |
| Static fan-out | `staticConcurrency=3`, `staticGroupSize=4` | `WORKFLOW_STATIC_*` | `:190-191` |
| Judge concurrency | `3` | `WORKFLOW_JUDGE_CONCURRENCY` | `:192` |
| Provider | `local` (`openai`/`anthropic`/`openai-compat`) | `LLM_PROVIDER` + khoá theo provider | `:105-166` |
| Compaction threshold tokens | `100000` | `LLM_COMPACT_THRESHOLD_TOKENS` | `:185` |
| Compaction keep recent turns | `3` | `LLM_COMPACT_KEEP_TURNS` | `:186` |

---

## 8. Ranh giới quyết định (decision boundaries)

Tổng hợp **mọi nơi** output (LLM hoặc heuristic) trở thành "leak / không leak". Đây là tóm tắt
trỏ về mã; phương pháp đo chi tiết ở [EVALUATION.md](./EVALUATION.md).

### 8.1. Collapse nhãn → boolean (chân lý duy nhất)

Một site được tính là **leak ⇔ verdict ∈ `{confirmed_leak, likely_leak}`**:

```ts
// packages/common/src/analysis/judge-shared.ts:33
export const LEAK_POSITIVE_VERDICTS: ReadonlySet<string> = new Set(['confirmed_leak', 'likely_leak']);
```

`uncertain`, `likely_false_positive`, `false_positive` đều **KHÔNG** flag. Tập này là ranh giới
nhị phân ở mọi consumer: consensus (`isFlag`, `consensus-judge.ts:59`) và bộ chấm eval
(`isFlagged`, `evalScoring.ts:79`). **Không có cutoff confidence** ở bất kỳ đâu trên đường dự
đoán/đo — confidence chỉ dùng cho cân consensus, hiển thị severity và calibration/ECE.

### 8.2. Heuristic judge (no-LLM, đồng thời là bộ chốt mọi bundle LLM bỏ sót)

`packages/common/src/analysis/heuristic-judge.ts:244-249` — cộng điểm tín hiệu rồi chia băng:

```ts
thresholds: VerdictThresholds = JUDGE_VERDICT_THRESHOLDS,  // { confirmed: 0.7, likely: 0.4 }
...
clamped >= thresholds.confirmed ? CONFIRMED_LEAK : clamped >= thresholds.likely ? LIKELY_LEAK : UNCERTAIN
```

Cộng/trừ điểm (theo thứ tự ưu tiên trong source `heuristic-judge.ts:64-241`):
- Runtime leak tương quan `definitely_lost`/`asan_leak`/`indirectly_lost`: `+0.5`
- Runtime leak tương quan `possibly_lost`: `+0.2`
- Runtime leak tương quan (kind unknown): `+0.4`
- Uncorrelated leak (khác site): `skip` (đã sửa bug `+0.15` cũ)
- Structural "high" missing free: `+0.5`
- Structural "medium" matched pattern: `+0.25`
- Alloc→free chưa cặp (unpaired): `+0.25`
- Conditional free (freed on some paths only): `+0.15`
- No free() in function: `+0.25`
- Reachable leak path khả thi: `+0.2`
- scan-build đồng tình: `+0.15`
- Path-sensitive leak: `+0.15`
- Ownership không chuyển ra: `+0.15`
- Ownership chuyển ra: `−0.25` / `−0.1` nếu có correlated leak
- Early return: `+0.1`
- Candidate confidence 'high': `+0.1`
- freed-via-callee (không có correlated runtime leak): **return `likely_false_positive (0.8)`** ngay

Ba **cổng precision** ghi đè kết quả:
1. **freedViaCallee** (`:222-233`): giao pointer cho callee free → `likely_false_positive (0.8)` (trừ khi có correlated runtime leak).
2. **Dynamic exculpation** (`:259-267`): dynamic chạy sạch + không decisive static evidence → `likely_false_positive (0.8)`.
3. **Strong signal gate** (`:274-285`): verdict "flagged" mà **thiếu tín hiệu mạnh** (`correlatedRuntimeLeak || structuralHigh || candidatePair?.status === 'unpaired' || pathSensitiveLeak || hasOwnershipIssue`) bị **hạ xuống `uncertain`**.

### 8.3. LLM judge — rubric, không phải ngưỡng số

Model tự chọn 1/5 nhãn theo rubric §3.2: runtime-linked ⇒ `confirmed_leak` conf ≥ 0.9;
ownership transfer / freed-all-paths / clean-run ⇒ `false_positive`. `confidence` model tự gán
**không** làm cổng flag.

### 8.4. Consensus

`combineVerdicts` (`consensus-judge.ts:151-225`):
- **Cờ flag** theo luật: `majority` = `flagging*2 > n`; `weighted` = `flagW/total > 0.5` (phiếu
  **nghịch** bằng chứng dynamic quyết định bị nhân `×0.3`); `unanimous-to-flag` = `flagging === n`.
- **Nhãn cuối** = verdict modal trong cụm đồng thuận (hoà → chọn **ít nghiêm trọng hơn**).
- **Veto:** exculpation mạnh của heuristic (`FP`/`likely_FP`, conf ≥ 0.75) **phủ quyết** cờ
  flag — override chỉ *gỡ* cờ, không *thêm*.

---

## 9. Bảng tổng hợp (prompt/instruction active)

| Tầng | Loại | Tên / hàm | File | Dòng | Định dạng |
|---|---|---|---|---|---|
| A | System | `staticSubAgentSystemPrompt` | `domain/subAgentPrompts.ts` | 39-54 | tool-calling |
| A | User | `staticSubAgentUserMessage` | `domain/subAgentPrompts.ts` | 56-63 | — |
| A | Nudge | static completion | `orchestrator/workflowInvestigation.ts` | 211-216 | — |
| B | System | `dynamicWorkerSystemPrompt` | `domain/subAgentPrompts.ts` | 67-78 | tool-calling |
| B | User | `dynamicWorkerUserMessage` | `domain/subAgentPrompts.ts` | 80-90 | — |
| B | Nudge | dynamic completion | `orchestrator/workflowInvestigation.ts` | 275-278 | — |
| B | (no-LLM) | `runDeterministicDynamic` | `domain/dynamicEvidence.ts` | 234-274 | — |
| D | System+User | `judgeBundleWithLlm` | `domain/llmJudge.ts` | 18-31, 193-211 | JSON only |
| D | Logic | `isBorderline` / `shouldEscalate` | `domain/llmJudge.ts` | 238-243, 256-287 | — |
| D | Logic | `combineVerdicts` (consensus) | `common/analysis/consensus-judge.ts` | 151-226 | — |
| — | Tool desc | done tools + `read_file` | `subAgentPrompts.ts` / `readFileTool.ts` | 17-26 / 17-43 | schema |
| — | Tool desc ×11 | static MCP | `static-analyzer/src/mcp/static-mcp-server.ts` | 38-127 | schema |
| — | Tool desc ×9 | dynamic MCP | `dynamic-analyzer/src/mcp/dynamic-mcp-server.ts` | 41-93 | schema |
| — | Notice | compaction / nudge / elided | `agent-core/src/loop.ts`, `compaction.ts` | 103,174 / 66 | — |
| POLICY | System | `allocatorProfileSystemPrompt` | `domain/allocatorProfiler.ts` | 90-103 | JSON only |
| POLICY | System | `strategistSystemPrompt` | `domain/strategist.ts` | 72-80 | JSON only |
| POLICY | System | `judgeTunerSystemPrompt` | `domain/judgeTuner.ts` | 51-56 | JSON only |

---

## 10. Compact summary — tập trung prompt gốc

### 10.1. Prompt dùng cho STATIC SUB-AGENT (Stage A)

**Mục đích:** Sub-agent gom bằng chứng tĩnh cho từng candidate.

**File:** `subAgentPrompts.ts:39-54`

```text
You are a STATIC-ANALYSIS evidence-gathering sub-agent for C/C++ memory leaks.
You do NOT record verdicts — your only job is to RUN the static tools so the system can collect structured evidence for each candidate, then call `done_static`.

For EACH candidate in your list, gather evidence:
- `functionSummary` (filePath, functionName) — alloc/free balance + leaky exit paths.
- `pathConstraints` (filePath, lineNumber of the allocation) — feasible leaking paths.
- `astScan` (filePath) — structural patterns + early returns.
- `ownershipConventions` (filePath) — ownership-transfer / missing-free conventions.
- `read_file` to inspect the source and, for interprocedural cases (a function returning an allocation), follow the caller.

Efficiency: you MAY call several of these read-only tools in a SINGLE turn — they run in parallel. The repository root is ${repoPath}.
When you have run the static tools for EVERY candidate in your list, call `done_static`. Do NOT reply with prose — only tool calls advance the work.
```

### 10.2. Prompt dùng cho DYNAMIC WORKER (Stage B)

**Mục đích:** Worker build project với sanitizer rồi chạy, findings tự động capture.

**File:** `subAgentPrompts.ts:67-78`

```text
You are a DYNAMIC-ANALYSIS sub-agent for C/C++ memory leaks. Build the project ONCE with a sanitizer, run it under a sanitizer, then call `done_dynamic`.

1. `read_file` the Makefile / CMakeLists.txt / build script under ${repoPath} to learn how it builds. A hint build command was provided: `${buildCommand}`.
2. `buildTarget` (projectPath=${repoPath}, buildCommand = a clang command with sanitizer flags). Prefer LeakSanitizer (`-fsanitize=leak -g -O0`) — it reports at exit and never aborts mid-run.
3. Run the binary with `lsanRun` (or `asanRun` / `valgrindMemcheck`).

The system CAPTURES every finding from your sanitizer runs AUTOMATICALLY and attaches it to the matching candidate — you do NOT record evidence yourself. Your only job is to get a successful sanitizer run.
Build at most ONCE and run each dynamic tool at most once. If a build or sanitizer fails twice, stop and call `done_dynamic`. When a sanitizer has run, call `done_dynamic`. Do NOT reply with prose.
```

### 10.3. Prompt dùng cho LLM JUDGE (Stage D)

**Mục đích:** Judge một allocation riêng lẻ, output verdict JSON. Chỉ gọi cho bundle borderline.

**File:** `llmJudge.ts:18-31`

```text
You are an expert C/C++ memory-leak analyst. Decide whether ONE allocation is a real leak, using the code, static context, and any runtime evidence provided.
Respond with a JSON object ONLY (no prose), in this exact shape:
{"verdict": "confirmed_leak | likely_leak | uncertain | likely_false_positive | false_positive", "confidence": 0.0-1.0, "explanation": "...", "evidence": ["..."]}
Calibrate using the EVIDENCE, in this priority order:
- A runtime leak (sanitizer/valgrind) whose allocation site is LINKED to this candidate is decisive → confirmed_leak (confidence ≥ 0.9). Weight by leak kind: definitely_lost / asan_leak ⇒ decisive; possibly_lost ⇒ weak corroboration; still_reachable ⇒ usually benign, lean false_positive.
- A runtime finding in the SAME FILE but a DIFFERENT site (not linked) is weak — do not treat it as proof for this allocation. still_reachable with no other evidence → false_positive.
- A CLEAN sanitizer/valgrind run that EXERCISED this allocation and reported NO leak here is strong evidence this is NOT a leak → lean false_positive / likely_false_positive (unless a runtime leak is LINKED to this very allocation).
- Ownership is decisive for false positives: if the allocation is RETURNED to the caller or its pointer is HANDED OFF to a sink/callback/another function (ownership transferred), freeing it is NOT this function's job. When ownership is transferred AND no runtime leak is linked to THIS allocation, answer likely_false_positive or false_positive — do NOT flag it just because you cannot see the free inside this snippet. An UNPAIRED alloc→free with a reachable leak path and NO ownership transfer → confirmed_leak (≥ 0.85).
- PATH-SENSITIVE leak: an allocation freed on the main/success path but NOT on an error or early-return path (e.g. `if (err) return NULL;` or `goto fail;` before the free) IS a leak — confirmed_leak — EVEN IF the value is returned or added to a structure on the success path. Ownership transferring on success does not cover the error path that loses the object. If the static context lists the allocation as freed "on some paths only" (conditional) or names it on a reachable un-freed exit path, treat that as decisive.
- PARAMETER-ownership leak (allocation_type 'parameter_ownership'): when a function frees a pointer PARAMETER on some paths (taking ownership from the caller, e.g. cJSON's `merge_patch` does `cJSON_Delete(target)`) but a reachable branch returns WITHOUT freeing it, that branch leaks the parameter — confirmed_leak. The parameter has no allocation site in the function; judge it by the conditional free + the reachable un-freed exit.
- Freed on all paths / static-global → false_positive (high confidence). Use uncertain only when the evidence is genuinely insufficient.
- Control flow is concrete, not hypothetical: a constant or scaffolding global such as `if(1)`/`if(0)` or `globalReturnsTrue()` does NOT change between two checks in the SAME function — `if(1)` always runs and `if(0)` is dead code. If the buffer is freed under the same condition it was allocated (or in the `else` of a constant `if`), it IS freed. Do NOT call a leak just because the `free()` sits in a different block, behind a constant condition, or after a `break`/in a second loop — trace whether it actually executes.
```

### 10.4. Prompt dùng cho ALLOCATOR PROFILER (Policy)

**Mục đích:** Khám phá allocator/deallocator custom của project. One-shot, temp 0.

**File:** `allocatorProfiler.ts:90-103`

```text
You are a C/C++ memory-management API analyst. Given header/source excerpts from ONE project, identify that project's CUSTOM allocation and deallocation functions — the wrappers/replacements for malloc/free: factory constructors and duplicators (`*_new`, `*_create*`, `*_alloc*`, `*_dup`, `*_clone`, `*_copy` that return owned memory) and their matching releases (`*_free`, `*_delete`, `*_destroy`, `*_release`, `*_unref`, `*_close`, pool/arena destructors) — plus any ownership conventions a leak checker must know.
Respond with a JSON object ONLY (no prose), in this exact shape:
{"allocators":["..."],"deallocators":["..."],"reallocators":["..."],"ownershipNotes":["..."],"confidence":0.0-1.0,"explanation":"..."}
Rules:
- Be EXHAUSTIVE on allocators: list EVERY function that returns newly-owned memory — ALL constructors/factories (`*_New*`, `*_Create*`), duplicators (`*_Duplicate`, `*_dup`, `*_clone`, `*_copy`), and parsers/printers/serializers that return an owned buffer (`*_Parse*`, `*_Print*`). Do not stop at a few examples — include the whole family even if it is long.
- Use EXACT function names as they appear in the code.
- Include INTERNAL/static helpers too (e.g. a static `cJSON_malloc`/`*_New_Item` wrapper, a private `*_strdup`), not only the public API — leaks often flow through them.
- Include MACRO allocators/deallocators: a `#define MY_ALLOC(n) malloc(n)` (or `#define FREE_OBJ(p) ...`) is an allocator/deallocator named `MY_ALLOC`/`FREE_OBJ` — list the macro name.
- Do NOT include plain libc malloc/calloc/realloc/free/strdup — the engine already knows those. Only the project's CUSTOM names.
- allocators/reallocators RETURN newly-owned heap memory the caller is responsible for; deallocators FREE or consume it.
- ownershipNotes: short, project-specific rules (transfer vs borrow, refcounting, pool/arena "free the pool, not each object", "X skips items flagged Y", a constructor that steals its argument). Empty array if none.
- Precision over recall: if unsure a name is an allocator/deallocator, OMIT it.
```

### 10.5. Prompt dùng cho STRATEGIST (Policy)

**Mục đích:** Chọn plan analysis (dynamic on/off, judge mode, static depth). One-shot, temp 0.

**File:** `strategist.ts:72-80`

```text
You are the STRATEGIST for a C/C++ memory-leak analyzer. Given a project's metadata + memory-API profile, choose an analysis plan by SELECTING among the engine's existing deterministic capabilities — you do not invent analysis. Respond with a JSON object ONLY:
{"runDynamic": true|false, "judge": "single"|"consensus", "staticDepth": "shallow"|"full", "rationale": "..."}
Guidance:
- runDynamic: run sanitizer (LeakSanitizer) dynamic analysis ONLY if the project is plausibly buildable (a build system is present) AND dynamic coverage would help. If there is NO build system, set false — building is impossible, so skip the expensive dynamic stage (no recall lost).
- judge: "consensus" (slower, more robust) for projects whose ownership is subtle — heavy smart-pointer / refcounting / C++; else "single".
- staticDepth: "shallow" (function summaries only) for tiny or trivial projects; "full" (path constraints + ownership + interprocedural) for larger or control-flow-heavy ones.
Be decisive; prefer cheaper plans when they lose no recall.
```

### 10.6. Prompt dùng cho JUDGE TUNER (Policy)

**Mục đích:** Nudge ngưỡng verdict cho hợp project. Clamp cứng, eval dùng default.

**File:** `judgeTuner.ts:51-56`

```text
You calibrate a C/C++ leak judge's verdict thresholds for ONE project. The judge scores each candidate in [0,1]; score ≥ confirmed → confirmed_leak, ≥ likely → likely_leak, else uncertain.
Defaults: confirmed=0.7, likely=0.4.
Nudge them to fit the project's memory style, staying near the defaults. Respond with JSON ONLY: {"confirmed": 0.55-0.85, "likely": 0.25-0.6, "rationale": "..."}.
Heuristics: heavy smart-pointer/RAII or refcounting (false positives likely) → RAISE confirmed slightly; a project with many obvious manual malloc/free and missing frees → LOWER thresholds slightly to catch more. Keep confirmed > likely. Small moves only.
```

### 10.7. Static tool descriptions bảng (5 content-capable tool)

| Tool | `description` (verbatim) |
|---|---|
| `candidateScan` | *Scan a file for allocation sites (malloc, calloc, realloc, strdup, new). Optionally supply per-project factory allocators / custom deallocators (≈ LAMeD AllocSource/FreeSink) so wrapper-named allocators (e.g. cJSON_Duplicate) become candidates.* |
| `astScan` | *AST-based structural analysis for memory leak patterns* |
| `functionSummary` | *Summarize a function: alloc/free balance, local vars, calls. Optionally supply per-project allocators/deallocators so factory-allocated vars are paired.* |
| `pathConstraints` | *Analyze path constraints and feasible paths around an allocation. Optionally supply per-project allocators/deallocators so factory allocations are tracked on exit paths.* |
| `ownershipConventions` | *Detect ownership-transfer conventions in a file* |

Lọc bởi `CONTENT_CAPABLE_TOOLS` (`mcpToolPlan.ts:103-109`). Các tool tĩnh còn lại (indexFiles, callGraph, interproceduralFlow, ownershipSummary, scanBuildRun, scanBuildGetReport) không phơi cho TUI vì cần filesystem mount chung.

### 10.8. Dynamic tool descriptions bảng (9 tool)

| Tool | `description` (verbatim) |
|---|---|
| `buildTarget` | *Build the project with sanitizer-instrumented compiler flags* |
| `valgrindMemcheck` | *Run Valgrind Memcheck for detailed leak analysis* |
| `valgrindGetReport` | *Retrieve a normalized Valgrind report* |
| `valgrindListFindings` | *Query Valgrind findings with optional filters* |
| `valgrindCompareRuns` | *Compare two Valgrind analysis runs* |
| `asanRun` | *Run the binary under AddressSanitizer for leak detection* |
| `lsanRun` | *Run the binary under LeakSanitizer* |
| `runBinary` | *Run a binary without instrumentation* |
| `listRuns` | *List stored dynamic analysis runs* |

### 10.9. Domain tool (read_file) + done tools

| Tool | `description` (verbatim) |
|---|---|
| `read_file` | *Read a source file from the repository (path relative to the repo root, or an absolute path inside it). Returns up to 16000 characters.* |
| `done_static` | *Finish static evidence gathering for this group of candidates.* |
| `done_dynamic` | *Finish dynamic evidence collection.* |
