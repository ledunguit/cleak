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
tầng**, định nghĩa ở `apps/leak-inspector-tui/src/orchestrator/workflowInvestigation.ts`. LLM
chỉ được gọi ở 3 chỗ (Stage A, Stage B-khi-cần, Stage D); Stage C và phần hợp nhất bằng chứng
là **tất định, không LLM**.

| Tầng | Việc | LLM? | Prompt |
|---|---|:--:|---|
| **A · Static fan-out** | nhiều **static sub-agent**, mỗi cái nhận một nhóm candidate, chạy tool tĩnh để **gom bằng chứng** — **không ra verdict** | ✅ | `staticSubAgentSystemPrompt` |
| **B · Dynamic** | nếu biết `buildCommand` → **công thức tất định, KHÔNG LLM** (`buildTarget → lsanRun`); nếu không → **1 dynamic worker (LLM)** build + chạy sanitizer | ⚙️/✅ | `dynamicWorkerSystemPrompt` |
| **C · Synthesize** | hợp nhất static context + dynamic evidence, đóng dấu coverage | ❌ | — |
| **D · Hybrid judge** | heuristic (tất định) cho **mọi** bundle; **LLM judge** chỉ cho bundle **borderline**; **consensus** (k mẫu) tuỳ chọn | ✅ | `llmJudge` SYSTEM_PROMPT |

Đặc điểm cốt lõi:
- **Phân vùng tool cứng:** static sub-agent chỉ nhận tool tĩnh; dynamic worker chỉ nhận tool
  động → LLM **không thể nhảy chéo** static↔dynamic. Thứ tự A–B chạy **song song**
  (`Promise.all`, `workflowInvestigation.ts:250`).
- **Bằng chứng được capture TỰ ĐỘNG:** static context và dynamic finding do code bắt
  (`withStaticContextCapture` / `withDynamicEvidenceCapture`), model **không** tự ghi.
- **Verdict do code ghi**, không qua LLM tool-call. Mọi lỗi gọi/parse model ở bất kỳ tầng nào
  → **rớt về heuristic** (an toàn, không tệ hơn).

**Provider dispatch** — `packages/agent-core/src/providers/index.ts:23-31`: `provider ===
'anthropic'` → `callAnthropic`, còn lại (`local` / `openai` / `openai-compat`) →
`callOpenAiChat`. Cách giao system prompt: Anthropic đặt ở tham số top-level `system`
(`providers/anthropic.ts:29`); OpenAI-compatible chèn làm message đầu `{role:'system',
content}` (`providers/normalize.ts:41`). Mặc định thesis: gateway OpenAI-compatible nội bộ
`local`, model `mimo/mimo-v2.5-pro` tại `localhost:20128/v1` (host-aware) — `config.ts:81-159`.

---

## 1. Stage A — Static sub-agent

Mỗi nhóm candidate (gom theo *file affinity*, `staticGroupSize=4`) sinh một sub-agent với
context nhỏ + bộ tool tĩnh giới hạn. Sub-agent chạy tới khi mọi candidate trong nhóm có
static context rồi gọi `done_static`.

### 1.1. System prompt — `staticSubAgentSystemPrompt(repoPath)`

- **File:** `apps/leak-inspector-tui/src/domain/subAgentPrompts.ts:39-54`
- **Biến nội suy:** `${repoPath}`.

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

### 1.2. User message — `staticSubAgentUserMessage(bundles)`

- **File:** `subAgentPrompts.ts:56-63` (mỗi candidate theo `candidateList`, `:28-35`).

```text
Gather static evidence for these ${N} candidate allocation site(s):
- ${bundleId} — ${function}() at ${file}:${line} (${allocation_type})
…

Run the static tools for each, then call done_static.
```

### 1.3. Tool phát cho model (Stage A)

`workflowInvestigation.ts:180-184`. Mô tả từng tool xem [§5](#5-mô-tả-tool-gửi-cho-model).
- **5 tool tĩnh content-capable**: `candidateScan`, `astScan`, `functionSummary`,
  `pathConstraints`, `ownershipConventions` — đây là **toàn bộ** tool tĩnh được phơi ra cho
  model (lọc bởi `CONTENT_CAPABLE_TOOLS`, `mcpToolPlan.ts:96-109`). 6 tool tĩnh còn lại
  (`indexFiles`, `callGraph`, `interproceduralFlow`, `ownershipSummary`, `leakguardRun`,
  `leakguardGetReport`) **bị loại** vì cần mount filesystem chung → giữ analyzer stateless,
  deploy được từ xa.
- `read_file` (xem [§5](#read_file--done-tool)).
- `done_static` — terminal tool kết thúc vòng lặp.

### 1.4. Completion nudge (chèn làm user message khi model định dừng sớm)

- **File:** `workflowInvestigation.ts:192-197` (guard `checkCompletion`, gọi từ
  `agent-core/loop.ts:168-177`, tối đa `maxStopNudges`).

```text
You stopped, but ${N} candidate(s) have NO static evidence yet: ${ids}. Run functionSummary/pathConstraints/astScan/ownershipConventions for them, then call done_static. Only tool calls advance the work.
```

---

## 2. Stage B — Dynamic worker

Chạy **song song** với Stage A. Chỉ bật khi `dynamicMode ≠ off` **và** có `dynamicClient`
(`workflowInvestigation.ts:112`). Có **hai nhánh**:

### 2.1. Nhánh tất định (KHÔNG LLM) — `runDeterministicDynamic`

- **File:** `apps/leak-inspector-tui/src/domain/dynamicEvidence.ts:179-217`.
- Khi case mang sẵn `buildCommand` (vd quy ước Juliet `make CC=clang CXX=clang++`), Stage B
  chạy **công thức cố định** `buildTarget(buildCommand) → lsanRun(a.out)` — **không prompt
  LLM** — để run (và do đó coverage/verdict) tái lập được. Chỉ rớt sang worker LLM khi build
  thất bại hoặc không có `buildCommand`.
- **Notice:** `Stage B · dynamic evidence: deterministic recipe (buildTarget → lsanRun, no LLM)`
  (`:212`); nếu hỏng: `Stage B · deterministic recipe produced no run — falling back to the LLM worker` (`:223`).

### 2.2. System prompt — `dynamicWorkerSystemPrompt(repoPath, buildCommand?)`

- **File:** `subAgentPrompts.ts:67-78`
- **Biến nội suy:** `${repoPath}`; dòng `A hint build command was provided: …` **chỉ** xuất
  hiện khi có `buildCommand`.

```text
You are a DYNAMIC-ANALYSIS sub-agent for C/C++ memory leaks. Build the project ONCE with a sanitizer, run it under a sanitizer, then call `done_dynamic`.

1. `read_file` the Makefile / CMakeLists.txt / build script under ${repoPath} to learn how it builds. A hint build command was provided: `${buildCommand}`.
2. `buildTarget` (projectPath=${repoPath}, buildCommand = a clang command with sanitizer flags). Prefer LeakSanitizer (`-fsanitize=leak -g -O0`) — it reports at exit and never aborts mid-run.
3. Run the binary with `lsanRun` (or `asanRun` / `valgrindMemcheck`).

The system CAPTURES every finding from your sanitizer runs AUTOMATICALLY and attaches it to the matching candidate — you do NOT record evidence yourself. Your only job is to get a successful sanitizer run.
Build at most ONCE and run each dynamic tool at most once. If a build or sanitizer fails twice, stop and call `done_dynamic`. When a sanitizer has run, call `done_dynamic`. Do NOT reply with prose.
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

Build once, run a sanitizer (the system captures the findings), then call done_dynamic.
```

### 2.4. Tool phát cho model (Stage B)

`workflowInvestigation.ts:230-234`: **9 tool động** (xem [§5](#dynamic-analyzer-9-tool)) bọc
trong `withDynamicEvidenceCapture` (finding được bắt tự động — `record_evidence` **cố tình
không** có trong toolset) + `read_file` + `done_dynamic`. `maxTurns` của worker = `maxTurns + 10`.

### 2.5. Completion nudge

- **File:** `workflowInvestigation.ts:243-246` (không cho worker dừng trước khi có một
  sanitizer run thành công).

```text
No successful sanitizer run yet. buildTarget (with a sanitizer flag), then run lsanRun/asanRun/valgrindMemcheck, then call done_dynamic. Only tool calls advance the work.
```

---

## 3. Stage D — Judge (LLM, chỉ cho bundle borderline)

Heuristic chấm **mọi** bundle trước (`heuristicVerdict`, `workflowInvestigation.ts:263-266`).
Chỉ những bundle **borderline / mâu thuẫn** mới được đẩy lên LLM; phần còn lại giữ verdict
heuristic.

### 3.1. Cổng leo thang — bundle nào lên LLM

- **`isBorderline`** — `apps/leak-inspector-tui/src/domain/llmJudge.ts:182-187`: verdict
  `likely_leak`/`uncertain`, **hoặc** `confidence ∈ [0.35, 0.7]`.
- **`shouldEscalate`** — `llmJudge.ts:200-231`: `isBorderline`, **hoặc** mâu thuẫn
  static↔verdict / dynamic↔verdict (vd cờ leak nhưng dynamic chạy sạch; không cờ nhưng có
  runtime leak tương quan; verdict nghịch `deriveFusion`). Đây là chỗ tái-kích-hoạt consensus
  khi nó cần nhất.

### 3.2. System prompt — `SYSTEM_PROMPT`

- **File:** `llmJudge.ts:16-27`
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
- Freed on all paths / static-global → false_positive (high confidence). Use uncertain only when the evidence is genuinely insufficient.
- Control flow is concrete, not hypothetical: a constant or scaffolding global such as `if(1)`/`if(0)` or `globalReturnsTrue()` does NOT change between two checks in the SAME function — `if(1)` always runs and `if(0)` is dead code. If the buffer is freed under the same condition it was allocated (or in the `else` of a constant `if`), it IS freed. Do NOT call a leak just because the `free()` sits in a different block, behind a constant condition, or after a `break`/in a second loop — trace whether it actually executes.
```

### 3.3. User message

- **File:** `llmJudge.ts:146-161`. `${sourceSnippet}` = **toàn bộ hàm bao** quanh allocation
  (đã **xoá comment** để không lộ nhãn benchmark; cửa sổ dự phòng ±(6,5) dòng,
  `judge-shared.ts:95`). `${summarizeStatic}` (`:41-84`) và `${summarizeEvidence}` (`:86-106`)
  dựng từ static context / dynamic evidence.

````text
ALLOCATION SITE: ${function}() at ${file}:${line} (${allocation_type})

CODE (context around the allocation):
```c
${sourceSnippet}
```

STATIC ANALYSIS CONTEXT:
${summarizeStatic}        # Ownership · Alloc→free pairing · Feasible leak paths (hoặc fallback đếm alloc/free/early-return)

DYNAMIC EVIDENCE (${N}):
${summarizeEvidence}      # mỗi finding: tool:kind bytes/blocks @ site [LINKED | same file, different site | CLEAN]; hoặc "(none)"

Return your JSON verdict.
````

### 3.4. Parse + làm giàu

`parseVerdict` (`llmJudge.ts:109-132`): `JSON.parse`, fallback regex `/\{[\s\S]*\}/`; chỉ nhận
nếu `verdict` là 1 trong 5 nhãn hợp lệ (`isLeakVerdictString`), `confidence` clamp `[0,1]`;
hỏng → `null` → giữ verdict heuristic. Verdict hợp lệ chạy qua `enrichLeakVerdict`
(`@mcpvul/common/analysis/heuristic-judge`) để gắn `rootCause` + repair diff source-anchored.

---

## 4. Consensus judge (tuỳ chọn — đóng góp luận văn)

Bật khi `CONSENSUS_N > 1`. **Không có prompt riêng** — `judgeByConsensus`
(`packages/common/src/analysis/consensus-judge.ts:257-268`) lấy mẫu **chính
`judgeBundleWithLlm`** N lần ở `CONSENSUS_TEMPERATURE` (do đó **tái dùng y nguyên** SYSTEM_PROMPT
§3.2), nối tại `workflowInvestigation.ts:280-285`. `combineVerdicts` (`:151-225`) gộp N nhãn
thành 1 cờ flag theo luật, rồi chọn nhãn modal trong cụm đồng thuận (xem [§8](#8-ranh-giới-quyết-định-decision-boundaries) cho con số).

---

## 5. Mô tả tool gửi cho model

Với native tool-calling, `description` của mỗi tool đi vào schema model thấy. Tool MCP được
nạp qua `loadMcpTools` → `wrapMcpTool` (`agent-core/src/mcp/mcpToolAdapter.ts:39-42`): giữ
nguyên `description` và `inputSchema` của tool từ xa. Chính sách thực thi
(`mcpToolPlan.ts:45-56`): tool truy vấn thuần (`CONCURRENCY_SAFE`) read-only + song song,
timeout 30s; tool nặng (`SERIAL_HEAVY`: build/sanitizer/scan-build) read-only + **tuần tự** +
**cần phê duyệt (`ask`)**, timeout 300s.

### Static analyzer (11 tool) — `apps/static-analyzer/src/mcp/static-mcp-server.ts:31-95`

| Tool | `description` (verbatim) | Phơi cho TUI? |
|---|---|:--:|
| `candidateScan` | *Scan a file for allocation sites (malloc, calloc, realloc, strdup, new)* | ✅ |
| `astScan` | *AST-based structural analysis for memory leak patterns* | ✅ |
| `functionSummary` | *Summarize a function: alloc/free balance, local vars, calls* | ✅ |
| `pathConstraints` | *Analyze path constraints and feasible paths around an allocation* | ✅ |
| `ownershipConventions` | *Detect ownership-transfer conventions in a file* | ✅ |
| `indexFiles` | *Index all C/C++ source files recursively from a root path* | ❌ |
| `callGraph` | *Extract call graph edges and nodes* | ❌ |
| `interproceduralFlow` | *Interprocedural data flow tracing for a function* | ❌ |
| `ownershipSummary` | *Summarize ownership conventions across files* | ❌ |
| `leakguardRun` | *Run the project-level Clang Static Analyzer (scan-build) over the project build* | ❌ |
| `leakguardGetReport` | *Retrieve Clang Static Analyzer (scan-build) findings* | ❌ |

> ❌ = bị loại khỏi TUI (cần filesystem mount chung) — `CONTENT_CAPABLE_TOOLS`,
> `mcpToolPlan.ts:96-109`. Slot `leakguard*` nay là Clang Static Analyzer (scan-build)
> self-contained.

### Dynamic analyzer (9 tool) — `apps/dynamic-analyzer/src/mcp/dynamic-mcp-server.ts:34-86`

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
| `read_file` | *Read a source file from the repository (path relative to the repo root, or an absolute path inside it). Returns up to 16000 characters.* | `apps/leak-inspector-tui/src/domain/domainTools.ts` |
| `done_static` | *Finish static evidence gathering for this group of candidates.* | `workflowInvestigation.ts:183` |
| `done_dynamic` | *Finish dynamic evidence collection.* | `workflowInvestigation.ts:233` |

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
  evidence: …` (`:177`), `Stage B · …` (`:205,212,223,225`), `Stage C · synthesize: …`
  (`:259`), `Stage D · judge: …` (`:262,272`).

---

## 7. Tham số điều khiển vòng lặp / judge — `apps/leak-inspector-tui/src/config.ts`

| Tham số | Mặc định | Env | Dòng |
|---|---|---|---|
| Turn tối đa mỗi sub-agent | `15` (dynamic worker `+10`) | `AGENT_MAX_TURNS` | `:174` (`workflowInvestigation.ts:239`) |
| Idle-timeout stream | `75000` ms | `LLM_IDLE_TIMEOUT_MS` (fallback `LLM_TIMEOUT_MS`) | `:85` |
| `maxStopNudges` | `3` | — | `agent-core/loop.ts` |
| Consensus N | `1` (opt-in 3/5 cho ablation) | `CONSENSUS_N` | `:187` |
| Consensus rule | `weighted` (`majority`/`weighted`/`unanimous-to-flag`) | `CONSENSUS_RULE` | `:188` |
| Consensus temperature | `0.7` | `CONSENSUS_TEMPERATURE` | `:190` |
| Judge temperature (single) | `0` | `JUDGE_LLM_TEMPERATURE` | `:92` |
| Static fan-out | `staticConcurrency=3`, `staticGroupSize=4` | `WORKFLOW_STATIC_*` | `:181-182` |
| Judge concurrency | `3` | `WORKFLOW_JUDGE_CONCURRENCY` | `:183` |
| Provider | `local` (`openai`/`anthropic`/`openai-compat`) | `LLM_PROVIDER` + khoá theo provider | `:81-159` |

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

`packages/common/src/analysis/heuristic-judge.ts:180-186` — cộng điểm tín hiệu rồi chia băng:

```ts
clamped >= 0.7 ? CONFIRMED_LEAK : clamped >= 0.4 ? LIKELY_LEAK : UNCERTAIN
```

Cộng/trừ điểm: runtime leak tương quan `+0.4–0.5`, structural "high" thiếu free `+0.5`,
alloc→free chưa cặp `+0.25`, path rò khả thi `+0.2`, ownership không chuyển ra `+0.15`,
**ownership chuyển ra `−0.1/−0.25`**, early-return `+0.1`. Hai **cổng precision** ghi đè băng:
freed-by-callee hoặc dynamic chạy sạch → `likely_false_positive (0.8)`; và một verdict
"flagged" mà **thiếu tín hiệu mạnh** (`correlatedRuntimeLeak || structuralHigh || unpaired ||
malloc_without_free`) bị **hạ xuống `uncertain`** (`:211-221`).

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
| A | Nudge | static completion | `orchestrator/workflowInvestigation.ts` | 192-197 | — |
| B | System | `dynamicWorkerSystemPrompt` | `domain/subAgentPrompts.ts` | 67-78 | tool-calling |
| B | User | `dynamicWorkerUserMessage` | `domain/subAgentPrompts.ts` | 80-90 | — |
| B | Nudge | dynamic completion | `orchestrator/workflowInvestigation.ts` | 243-246 | — |
| B | (no-LLM) | `runDeterministicDynamic` | `domain/dynamicEvidence.ts` | 179-217 | — |
| D | System+User | `judgeBundleWithLlm` | `domain/llmJudge.ts` | 16-27, 146-161 | JSON only |
| D | Logic | `isBorderline` / `shouldEscalate` | `domain/llmJudge.ts` | 182-231 | — |
| D | Logic | `combineVerdicts` (consensus) | `common/analysis/consensus-judge.ts` | 151-225 | — |
| — | Tool desc | done tools + `read_file` | `subAgentPrompts.ts` / `domainTools.ts` | 17-26 / — | schema |
| — | Tool desc ×11 | static MCP | `static-analyzer/src/mcp/static-mcp-server.ts` | 31-95 | schema |
| — | Tool desc ×9 | dynamic MCP | `dynamic-analyzer/src/mcp/dynamic-mcp-server.ts` | 34-86 | schema |
| — | Notice | compaction / nudge / elided | `agent-core/src/loop.ts`, `compaction.ts` | 103,174 / 66 | — |
