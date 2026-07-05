# Đề cương luận văn thạc sĩ
# Theo khung: paper/scaffold.md

---

# Tên đề tài

- Tiếng Việt: **Điều tra rò rỉ bộ nhớ C/C++ dựa trên điều phối đa tác tử LLM: tích hợp phân tích tĩnh, động và cơ chế đồng thuận phán quyết**
- Tiếng Anh: **LLM-Orchestrated Memory Leak Investigation for C/C++ Repositories: Integrating Static Analysis, Dynamic Analysis, and Consensus Verdict Mechanisms**

---

# Tổng quan đề tài

## Đặt vấn đề

Memory leak (rò rỉ bộ nhớ) trong C/C++ là một trong những loại lỗi phổ biến và nguy hiểm nhất, là nguồn gốc của hàng trăm CVE mỗi năm trong các dự án lớn như curl, OpenSSL, Linux kernel. Không như các ngôn ngữ có garbage collector (Java, Go, Python), C/C++ yêu cầu lập trình viên tự quản lý bộ nhớ — một thao tác mà ngay cả lập trình viên kinh nghiệm cũng dễ mắc sai sót, đặc biệt trong các đoạn mã phức tạp với nhiều nhánh điều kiện, vòng lặp, và hàm đệ quy.

Công cụ truyền thống đối mặt đánh đổi cố hữu: phân tích tĩnh (Clang Static Analyzer, Infer, CodeQL) có FP (false positive) cao trên mã phức tạp — điển hình là LAMeD [1] chỉ ra rằng ngay cả CodeQL cũng tạo ra 139–653 cảnh báo trên 43 leak thật; phân tích động (Valgrind, ASan/LSan) có recall cao nhưng chỉ phát hiện leak trên đường thực thi thực sự, bỏ sót các leak trên đường lỗi hiếm khi chạy tới.

Gần đây, mô hình ngôn ngữ lớn (LLM) đã chứng minh khả năng hiểu ngữ nghĩa code, lý luận đa bước, và phối hợp công cụ. Các hệ thống như FuzzingBrain V2 [2] (multi-agent trên MCP, 90% phát hiện lỗ hỗng trong AIxCC 2025), RepoAudit [3] (agentic + validator, $2.54/dự án), và ATLANTIS [4] (vô địch AIxCC 2025) mở ra hướng mới: dùng LLM làm orchestrator phối hợp nhiều analyzer. Tuy nhiên, tất cả đều nhắm vào crash/lỗ hỗng nói chung — **chưa có hệ thống nào kết hợp LLM orchestration chuyên cho memory leak C/C++**, nơi bằng chứng tĩnh (cấu trúc cấp phát–giải phóng) và bằng chứng động (runtime sanitizer) bổ sung nhau một cách tự nhiên.

Đây là cơ sở cho đề tài: xây dựng một hệ thống đa tác tử, trong đó LLM điều phối các analyzer tĩnh và động qua giao thức MCP (Model Context Protocol), hợp nhất bằng chứng bằng tầng phán xét hybrid (heuristic + LLM + đồng thuận), và đánh giá trên cả corpus tổng hợp (Juliet CWE-401, 1658 ca) lẫn dự án thực (LAMeD benchmark, 41 ca từ 7 dự án open-source).

---

# Mục tiêu đề tài

**Mục tiêu tổng quát:** Thiết kế, cài đặt và đánh giá một hệ thống phát hiện memory leak C/C++ sử dụng LLM làm orchestrator đa tác tử, tích hợp phân tích tĩnh (AST, call graph, path constraints) và phân tích động (LeakSanitizer, AddressSanitizer, Valgrind), với cơ chế đồng thuận phán quyết để giảm dao động giữa các lần chạy.

**Mục tiêu cụ thể:**

1. Thiết kế kiến trúc HYBRID pipeline gồm 4 tầng (khám phá tĩnh → làm giàu bằng chứng → điều tra agentic → phán xét hybrid), trong đó LLM sở hữu quyết định theo-từng-project (POLICY) còn engine tất định sở hữu cơ chế phân tích (MECHANISM).
2. Cài đặt tầng phán xét đồng thuận (consensus judge) lấy K mẫu verdict độc lập rồi bỏ phiếu, nhằm giảm tỉ lệ lật verdict run-to-run — một vấn đề chưa được giải quyết trong các hệ thống LLM-as-judge hiện tại.
3. Thiết kế giao thức tái lập hai tầng: Tier-1 (no_llm, tất định bit-for-bit) cho baseline reproducible, Tier-2 (llm_assisted, báo cáo phân phối) cho đánh giá công bằng.
4. Đánh giá trên Juliet CWE-401 (1658 ca, validated) bằng ablation 9-baseline capability và trên LAMeD benchmark (41 ca real-project leak từ curl, libtiff, cjson, v.v.), so sánh với Clang Static Analyzer.

---

# Phạm vi và giới hạn đề tài

## Phạm vi và đối tượng nghiên cứu

- **Ngôn ngữ:** C và C++ (không bao gồm Rust, Java, hay các ngôn ngữ có GC).
- **Loại lỗi:** Memory leak — cụ thể CWE-401 (Missing Release of Memory after Effective Lifetime), bao gồm các biến thể: missing free, path-sensitive leak, interprocedural leak, parameter-ownership leak.
- **Corpus đánh giá:** Juliet Test Suite CWE-401 (NIST, 1658 test cases đã validated) và LAMeD benchmark (41 leak từ 7 dự án thực: curl, libtiff, cjson, libxml2, libssh2, libsolv, rabbitmq-c).
- **LLM sử dụng:** mimo/mimo-v2.5-pro (local gateway, OpenAI-compatible API).

## Giới hạn của đề tài

- Corpus dự án thực (LAMeD) chỉ có 41 ca positive-only — chưa đủ để đánh giá đầy đủ precision trên dự án thực.
- Chỉ đánh giá trên 1 mô hình LLM (mimo/mimo-v2.5-pro) — kết quả có thể khác với GPT-4, Claude, hay Gemini.
- SMT path-feasibility (Z3) đã bị loại khỏi kiến trúc do trần heap 2 GiB WASM — phân tích path-sensitive chỉ ở mức heuristic CFG.
- Phân tích dynamic yêu cầu Linux (Valgrind/LSan không chạy native trên macOS) — thực nghiệm chạy qua Docker.
- Baseline bên ngoài mỏng: chỉ LAMeD (EASE 2025) là peer-reviewed đầy đủ; phần còn lại là preprint/tech-report.

## Phương pháp phân tích cấu trúc, phân rã hệ thống

Hệ thống được phân rã thành 5 thành phần chính theo nguyên tắc tách biệt concerns:
- **Orchestrator** (leak-inspector-tui): điều phối pipeline, quản lý sub-agents, tổng hợp kết quả.
- **Static analyzer**: 11 MCP tools phục vụ phân tích AST, call graph, path constraints.
- **Dynamic analyzer**: 9 MCP tools phục vụ build, chạy sanitizer, so sánh run.
- **Agent core**: vòng lặp tool-calling native, multi-provider streaming, context compaction.
- **Common library**: shared types, heuristic judge, consensus judge, report renderer.

Mỗi thành phần được thiết kế độc lập, giao tiếp qua MCP Streamable-HTTP, cho phép thay thế hoặc mở rộng từng phần mà không ảnh hưởng phần khác.

## Thiết kế hệ thống

- **Kiến trúc HYBRID pipeline:** profiling (LLM, optional) → strategy (LLM, optional) → discovery (deterministic) → static enrichment (deterministic, optional) → investigation (agentic, llm_assisted) → judging (hybrid) → reporting.
- **Nguyên tắc cốt lõi:** LLM sở hữu POLICY (khám phá allocator, chiến lược, hiệu chỉnh judge), engine sở hữu MECHANISM (parse tree-sitter, CFG, alloc→free pairing, scoring).
- **Giao thức:** MCP (Model Context Protocol) Streamable-HTTP giữa orchestrator và analyzers; LLM streaming qua HTTP SSE.

## Triển khai hệ thống

- TypeScript + Bun runtime; NestJS cho analyzer services; Ink cho TUI.
- Docker Compose cho static-analyzer (port 50061) và dynamic-analyzer (port 50062).
- MCP SDK (`@modelcontextprotocol/sdk`) cho tool registration và client.
- Monorepo Turborepo: `apps/` (3 ứng dụng) + `packages/` (2 thư viện chia sẻ).

## Phương pháp nghiên cứu

- **Thực nghiệm so sánh (comparative experiment):** chạy hệ thống trên cùng corpus, cùng scorer, so sánh với baseline (Clang Static Analyzer).
- **Ablation study:** 9-baseline capability ablation phân rã kiến trúc thành 5 trục độc lập [static, dynamic, planner, tool_selector, fusion] để đo đóng góp từng thành phần.
- **Phân tích phương sai (variance analysis):** multi-run (3–5 lần) cho mỗi cấu hình LLM, báo cáo mean ± std, McNemar test cho paired comparison.
- **Corpus integrity pipeline:** 5-gate validator (schema, structural, compile, label, content-hash) đảm bảo dữ liệu đánh giá đáng tin cậy.

---

# Các nội dung chính

## Chương 1: Các nghiên cứu và công nghệ liên quan (~25 trang)

### 1.1. Memory leak trong C/C++: định nghĩa, phân loại, tác động
- CWE-401 (Missing Release of Memory after Effective Lifetime) và các biến thể
- Patterns phổ biến: missing free, path-sensitive, interprocedural, factory-allocator, parameter-ownership
- Tác động thực tế: CVE trong curl, OpenSSL, Linux kernel
- Độ phức tạp bài toán: alias analysis, ownership transfer, path feasibility

### 1.2. Phân tích tĩnh cho memory leak
- Clang Static Analyzer: kỹ thuật, khả năng, giới hạn (FP cao trên code phức tạp)
- Facebook Infer: separation logic, biabduction
- CodeQL: truy vấn logic cho CWE-401
- Tree-sitter: parsing nhẹ cho phân tích cấu trúc AST
- Abstract interpretation và symbolic execution
- Các hướng kết hợp LLM + static: MemHint [5] (LLM + Z3), LAMeD [1] (LLM annotation)

### 1.3. Phân tích động cho memory leak
- Valgrind Memcheck: instrumentation-based
- AddressSanitizer / LeakSanitizer: compiler-based
- Fuzzing kết hợp sanitizer (AFL++, libFuzzer)
- Hạn chế: coverage thấp, chỉ phát hiện trên đường thực thi

### 1.4. LLM cho phát hiện lỗi phần mềm
- LLM code understanding: khả năng và giới hạn
- LLM + tool augmentation: ReAct, native tool-calling
- LLM + formal methods: MemHint (LLM + Z3), POM [6] (LLM + SAT)
- Multi-agent LLM systems: FuzzingBrain V2 [2], RepoAudit [3], ATLANTIS [4], Buttercup
- Bảng so sánh tổng hợp các hệ thống liên quan

### 1.5. Cơ chế đồng thuận và giảm phương sai LLM
- Self-consistency decoding (Wang et al., 2022)
- LLM-as-judge: calibration, hạn chế, dao động verdict
- Consensus voting trong hệ multi-agent
- McNemar test và paired comparison cho đánh giá LLM

### 1.6. Benchmarks và datasets
- Juliet Test Suite (NIST): CWE-401, cấu trúc, quy mô
- LAMeD benchmark: real-project leak, Zenodo 15089703
- DiverseVul, SecVulEval
- Khoảng trống: thiếu benchmark leak C/C++ đa dạng, có ground-truth function-level

### 1.7. Tổng kết và vị trí nghiên cứu
- Khoảng trống mà luận văn nhắm lấp đầy
- Bảng so sánh định vị hệ thống vs. các baseline

---

## Chương 2: Lập kế hoạch, phân tích và thiết kế hệ thống (~30 trang)

### 2.1. Yêu cầu và ràng buộc
- Yêu cầu chức năng: phát hiện leak, phân loại severity, gợi ý sửa chữa
- Yêu cầu phi chức năng: tái lập được, mở rộng được, chi phí token hợp lý
- Ràng buộc kỹ thuật: MCP protocol, Docker deployment, multi-provider LLM

### 2.2. Phân tích bài toán và lựa chọn kiến trúc
- Tại sao hybrid (static + dynamic) thay vì chỉ static hoặc chỉ dynamic
- Tại sao LLM orchestration thay vì hardcode pipeline
- Tại sao MCP thay vì gRPC/REST truyền thống
- Nguyên tắc thiết kế: LLM owns POLICY, engine owns MECHANISM

### 2.3. Thiết kế tổng quan
- Pipeline HYBRID 4-stage: discovery → enrichment → investigation → judging
- Sơ đồ thành phần và giao thức giao tiếp
- Luồng dữ liệu: LeakCandidate → LeakBundle → VerdictResult → ScanReport

### 2.4. Thiết kế tầng khám phá tĩnh (Discovery)
- Candidate scan: libc + factory allocator + C++ new + parameter-ownership
- Attribution hàm bằng tree-sitter (range-based routing C/C++)
- LLM allocator profiler: khám phá API theo project → verify (grep) → cache

### 2.5. Thiết kế tầng làm giàu bằng chứng tĩnh (Static Enrichment)
- Function summary: alloc→free pairing, leaky exit paths
- Path constraints: guard-subset reconciliation (heuristic CFG)
- Interprocedural flow: variable-level cross-frame matching
- Clang scan-build: project-level corroborative evidence

### 2.6. Thiết kế tầng điều tra agentic (Investigation)
- Stage A: Static fan-out sub-agents (native tool-calling, tool partitioning)
- Stage B: Dynamic worker (deterministic recipe vs LLM fallback)
- Stage C: Synthesize (deterministic context merge)
- Tool partitioning: static-only vs dynamic-only agents

### 2.7. Thiết kế tầng phán xét hybrid (Judging)
- Heuristic judge: path-sensitive scoring (alloc→free pairing, guard reconciliation)
- LLM judge: rubric-based, JSON-only output, borderline escalation
- Consensus judge: K-sample voting, 3 rules (majority/weighted/unanimous), precision-override veto
- Escalation logic: static↔dynamic disagreement detection

### 2.8. Thiết kế giao thức tái lập hai tầng
- Tier-1: no_llm bitwise determinism (recipe ghim + capture tất định)
- Tier-2: llm_assisted variance reporting (mean ± std, verdict-stability, McNemar)
- Determinism gate: assert-determinism.ts, chống self-compare và degenerate run

### 2.9. Thiết kế corpus pipeline
- Juliet ingest: NIST v1.3 → labeled manifest (bad/good convention)
- LAMeD ingest: Zenodo → bug-commit checkout
- validate-corpus.ts: 5-gate (schema, structural, compile, label, content-hash)
- Lockfile và content-hash provenance

---

## Chương 3: Hiện thực, triển khai hệ thống (~20 trang)

### 3.1. Công nghệ sử dụng và cấu trúc dự án
- TypeScript, Bun, NestJS, Tree-sitter, Ink TUI
- MCP SDK, agent-core, Docker Compose
- Monorepo Turborepo: apps/ + packages/

### 3.2. Cài đặt static analyzer
- C-parser service: tree-sitter-c / tree-sitter-cpp routing theo đuôi file
- Allocator set per-parse: extraAllocators/Deallocators threading xuyên suốt
- Path-sensitive: collectLineGuards → guard-subset reconciliation → AllocFreePair.status
- Reachability bảo thủ: collectDeadLines (terminator detection)
- 11 MCP tools: candidateScan, astScan, callGraph, functionSummary, pathConstraints, interproceduralFlow, ownershipSummary, ownershipConventions, scanBuildRun, scanBuildGetReport, indexFiles

### 3.3. Cài đặt dynamic analyzer
- Build orchestration: sanitizer flags (-fsanitize=leak, -fsanitize=address)
- Valgrind integration: child_process, normalized report
- ASan/LSan integration: unlimitedAddressSpace, llvm-symbolizer
- 9 MCP tools

### 3.4. Cài đặt agent core
- Native tool-calling loop: queryLoop, tool dispatch
- Multi-provider streaming: OpenAI, Anthropic, openai-compat
- Idle-timeout (reset theo chunk) + context compaction
- MCP client adapter: StreamableHTTPClientTransport

### 3.5. Cài đặt orchestrator (leak-inspector-tui)
- workflowInvestigation.ts: 4-stage pipeline
- Sub-agent prompts: staticSubAgentSystemPrompt, dynamicWorkerSystemPrompt
- Dynamic evidence: runDeterministicDynamic + withDynamicEvidenceCapture
- LLM judge: parseVerdict, isBorderline, shouldEscalate
- CLI/TUI interface: Ink components

### 3.6. Cài đặt common library (@cleak/common)
- LeakBundle types và Zod schemas
- Heuristic judge: scoring function, threshold gates
- Consensus judge: combineVerdicts, weighted voting, precision-override veto
- Report renderers: JSON/MD/HTML/snapshot

### 3.7. Cài đặt tầng LLM-generalization (POLICY)
- Allocator profiler: LLM → Zod parse → grep-verify → cache .cleak/
- Strategist: per-project configuration, fallback rule-based
- Judge tuner: bounded threshold nudge, eval bypass

### 3.8. Triển khai và vận hành
- Docker Compose: static-analyzer (50061) + dynamic-analyzer (50062)
- LLM gateway: local (mimo/mimo-v2.5-pro) tại port 20128
- Configuration: CLI flags, env vars, ~/.config/cleak/config.json
- Corpus pipeline: ingest → validate → lock → gate

---

## Chương 4: Đánh giá kết quả (~30 trang)

### 4.1. Thiết kế thực nghiệm
- Corpus: Juliet CWE-401 (1658 ca, validated, lockfile f578c3ee) + LAMeD (41 ca, 7 dự án)
- Scoring model: function-mode (one sample per ground-truth site)
- Metrics: Precision, Recall, F1, ECE (Expected Calibration Error), FP/KLOC
- Sampling: stratified round-robin (deterministic, không top-N)
- Fairness rules: positive-only tools (TN=0, bỏ specificity/MCC)
- LLM: mimo/mimo-v2.5-pro, temperature 0 (judge single), 0.7 (consensus sample)

### 4.2. Ablation 9-baseline capability (headline)
- Thiết kế: 5 axes [static, dynamic, planner, tool_selector, fusion], 9 baselines B1–B7
- Kết quả n=50 stratified trên validated corpus
- Kết quả n=100 stratified
- Bàn luận: B6a winner (F1 0.938, P 0.973, 463k tok); dynamic = FP-killer (B4: 18 FP → B6: 1 FP); agentic tool_selector counter-productive trên Juliet (F1 0.929 @ 4.2M tok)

### 4.3. Ma trận 2×2 (LLM orchestration × Dynamic evidence)
- Kết quả: no_llm ≡ llm_assisted trên Juliet (cùng TP29 FP7 FN3)
- Dynamic adds recall (FN 3→2), FP stable
- Giải thích: Juliet corpus dễ → non-borderline bundles → LLM judge never engages

### 4.4. Static evidence-tool ablation
- functionSummary + pathConstraints: synergistic (recall 0.792 → 0.943 khi kết hợp)
- interproceduralFlow: Δ0 trên Juliet (intra-function), +1 TP trên LAMeD (cross-function)
- scan-build: corroborative (ECE improvement, verdict unchanged)
- Bàn luận: 2 tool mặc định là backbone, opt-in tools cho hard corpus

### 4.5. Đánh giá trên LAMeD (dự án thực)
- Static parity: 12/41 TP (sau nâng cấp allocator-aware), FP=0
- So sánh Clang: 0/43 (Clang) vs 12/41 (hệ thống) — vượt Clang ở recall, giữ precision 1.0
- Case study: cjson merge_patch — leak đầu tiên bắt được trên dự án thực
- Phân tích 6 leak classes cjson: deallocator-semantics, path-sensitive, control-flow, parameter-ownership
- Giới hạn: 32/41 FN còn lại — phần lớn cần phân tích sâu hơn (alias-aware, deallocator modeling)

### 4.6. Ablation consensus judge
- Verdict stability: single-LLM 26.7% → consensus 6.7% flip rate (giảm 4×)
- Replicated chính xác qua 2 campaigns (6.7% / 93.3% / 96.7% cả 2 lần)
- McNemar test (campaign B, 77 sites): consensus acc 83.1% vs single 79.2%, p=0.45 (trend, chưa significant)
- Bàn luận: consensus ổn định hơn ~2–4×, bội số phụ thuộc baseline single-LLM (vốn nhiễu)

### 4.7. So sánh với baseline bên ngoài
- Juliet n=30: system F1 0.853 vs Clang F1 0.761, FP/KLOC 0.741 vs 1.270
- LAMeD: system 12/41 (FP=0) vs Clang 0/43
- MemHint: 52–54 leak trên 7 dự án lớn (preprint, chưa peer-review) — so leak count
- LAMeD paper: CodeQL 5→10, Cooddy 5→10 (với annotation) — so recall

### 4.8. Xác minh tái lập
- Tier-1: 2 lần chạy no_llm → TP29 FP7 FN3 TN38 y hệt (determinism-gate PASS)
- Tier-2: B6a 3 runs → F1 mean 0.935 ± 0.020, P mean 0.973 ± 0.031
- B7 3 runs → F1 mean 0.938 ± 0.015

### 4.9. Độ chính xác LLM allocator profiling
- Allocator Recall 85%, Deallocator Recall 100% (mimo local, temp 0, cjson)
- LLM phát hiện nhiều allocator hơn list hardcode (cJSON_Parse/Print trả owned memory)
- Ownership notes chính xác → thread vào LLM judge cho ngữ nghĩa deallocator

### 4.10. Tổng hợp và thảo luận kết quả
- Bảng tổng hợp tất cả kết quả trên 2 corpus
- Chi phí token: tổng sweep 10.6M tok, B6a 463k vs B7 4.1M (9× cho F1 thấp hơn)
- Điều kiện nào LLM orchestration có lợi: hard corpus, borderline bundles, cross-function leaks

---

## Chương 5: Kết luận và hướng phát triển trong tương lai (~15 trang)

### 5.1. Trả lời câu hỏi nghiên cứu
- RQ1: Trên Juliet dễ, heuristic baseline mạnh nhất (F1 0.938 B6a). Trên LAMeD khó, hệ thống vượt Clang (12/41 vs 0/43). LLM orchestration có lợi khi corpus phức tạp, borderline.
- RQ2: Dynamic giảm FP hiệu quả: B4 (static+LLM) 18 FP → B6 (+dynamic) 1 FP. FP stable ở mọi cell.
- RQ3: Consensus K=3 giảm flip rate 4× (26.7% → 6.7%), replicated chính xác qua 2 campaigns.
- RQ4: LAMeD — precision 1.0, recall 0.273, vượt Clang 0/43. Đạt trong dải LAMeD tự báo (5–10/43).

### 5.2. Đóng góp của luận văn
- C1: Consensus judge hợp nhất static+dynamic + self-consistency (first-of-its-kind cho leak C/C++)
- C2: Giao thức tái lập hai tầng (Tier-1 bitwise + Tier-2 variance + determinism gate)
- C3: Tất định hoá dynamic (deterministic recipe, no LLM in the loop)
- C4: Evidence enrichment có cấu trúc (ownership, alloc→free pairs, feasible leak paths, dynamic correlation)

### 5.3. Bàn luận
- Juliet là corpus dễ — kết quả cần mở rộng sang corpus khó hơn
- Agentic tool_selector counter-productive trên easy corpus — cần kiểm chứng trên hard corpus
- Path-sensitive: heuristic CFG over-report (FP 7→44 khi bật), SMT bị loại (WASM limitation)
- Chi phí token: B6a (463k) là sweet spot cho Juliet; B7 (4.1M) cần chứng minh trên hard corpus
- LLM-as-judge: dao động run-to-run là bản chất (provider-side batching), consensus giảm nhưng không消除

### 5.4. Threats to validity
- Corpus: Juliet synthetic, LAMeD small (41 ca positive-only)
- Single model: chỉ mimo/mimo-v2.5-pro
- Baseline thin: chỉ LAMeD peer-reviewed
- Real-project recall: 0.273 — còn thấp, nhiều FN là deallocator-semantics chưa mô hình hoá

### 5.5. Hướng phát triển tương lai
- Alias-aware interprocedural dataflow (cross-frame variable aliasing)
- Deallocator semantics modeling (LLM-discovered, verify, cache)
- Harder corpus: mở rộng real-project benchmarks
- Multi-model evaluation: GPT-4o, Claude, Gemini
- MCP ecosystem integration: community analyzer tools
- Rust/Go extension: ownership-aware analysis cho Rust (borrow checker assisted)
- Cost optimization: cache static analysis results, minimize LLM calls

---

# Kế hoạch thực hiện

| Giai đoạn | Thời gian | Nội dung |
|---|---|---|
| 1. Nghiên cứu & Thiết kế | Tháng 1 | Khảo sát tài liệu, xác định khoảng trống, thiết kế kiến trúc HYBRID pipeline |
| 2. Cài đặt phần cứng | Tháng 2–3 | Triển khai static analyzer, dynamic analyzer, agent core, orchestrator, common library |
| 3. Cải tiến & Tích hợp | Tháng 4 | Consensus judge, evidence enrichment, LLM-generalization (POLICY), corpus pipeline |
| 4. Đánh giá | Tháng 5 | Chạy benchmark Juliet (n=100) + LAMeD, ablation study, baseline comparison, variance analysis |
| 5. Viết luận văn & Bảo vệ | Tháng 6 | Viết luận văn, chỉnh sửa, phản biện nội bộ, nộp và bảo vệ |

---

# Tài liệu tham khảo

> Danh sách đầy đủ 43 references đã xác minh: xem `paper/references/bibliography.md`.
> Đánh số [1]–[43] thống nhất trong toàn bộ luận văn.

**Tóm tắt theo nhóm:**

| Nhóm | Số lượng | Ví dụ chính |
|---|---|---|
| Công cụ phân tích tĩnh | 6 | Clang SA [1], Infer [2], CodeQL [3], Tree-sitter [4], NESA [5], CodeChecker [6] |
| Công cụ phân tích động | 8 | Valgrind [7], ASan [8], RangeSanitizer [9], QMSan [10], AirTaint [12], AddressWatcher [14] |
| LLM cho phát hiện lỗi | 5 | Khare [15], IRIS [16], VulnLLM-R [18], SemTaint [19] |
| Leak C/C++ trực tiếp | 3 | MemHint [20], LAMeD [21], MLEE kernel [22] |
| Agentic / Multi-agent | 5 | Revelio [23], SAILOR [24], RepoAudit [25], FuzzingBrain V2 [26], ATLANTIS [27] |
| LLM Foundations | 9 | ReAct [28], Self-consistency [29], Reflexion [30], ToT [31], DSPy [32], SWE-agent [34], Agentless [35], LLM-as-judge [36] |
| Benchmarks | 5 | Juliet [37], LAMeD [38], DiverseVul [39], SV-COMP [40], Magma [41] |
| Giao thức | 2 | MCP [42], POM [43] |
