# Thuật ngữ (Glossary)

Định nghĩa ngắn các thuật ngữ dùng xuyên suốt tài liệu & mã nguồn.

## Kiến trúc & thành phần
- **leak-inspector-tui** — app CLI/TUI (Ink/React) — **bộ điều phối duy nhất** của hệ thống,
  dùng **native tool-calling**; quét nhanh + eval/benchmark. (Đường **web** cũ — control-plane
  NestJS + UI React — được lưu trên nhánh git `web-implementation`, không còn trên master.)
- **agent-core** (`packages/agent-core`) — vòng lặp tool-calling không-framework: MCP client,
  `callModel` đa-provider (streaming), idle-timeout, nén ngữ cảnh.
- **common** (`packages/common`) — types/Zod schema/`scoreCase`/judges/reporting dùng chung.
- **static-analyzer / dynamic-analyzer** — hai app NestJS phục vụ **MCP** cho TUI (transport
  duy nhất; mã gRPC/`proto` đã gỡ): phân tích tĩnh (index, candidate/AST scan, call-graph,
  interprocedural flow, Clang `scan-build`) và động (build sanitizer + chạy Valgrind/ASan/LSan).
- **MCP** (Model Context Protocol) — giao thức JSON-RPC 2.0 streamable-HTTP để LLM/agent gọi
  tool của analyzer.

## Dữ liệu & quét
- **LeakBundle** — đơn vị dữ liệu gom MỘT ứng viên leak + bằng chứng static/dynamic + verdict;
  chuẩn hoá để judge & report tiêu thụ.
- **VerdictResult** — verdict của một bundle: `verdict` (confirmed_leak | likely_leak |
  uncertain | likely_false_positive | false_positive), `confidence`, `tool`, giải thích,
  rootCause, repairDiff.
- **dynamicCoverage** — trạng thái trung thực tầng dynamic đã xác lập được gì:
  `exercised_clean` (đã chạy, sạch) · `exercised_leak` (đã chạy, thấy rò) · `not_exercised`
  (chưa chạy tới) · `dynamic_off` (tắt dynamic).
- **correlation (LINKED vs file-only)** — mức tương quan giữa rò rỉ runtime và ứng viên:
  `file_line_exact/near` hay `function_match` ⇒ **LINKED** (quyết định); `file_only` ⇒ yếu;
  còn lại ⇒ unlinked.
- **snapshot.json** — định dạng máy-so-sánh chuẩn của một lần quét (findings + bằng chứng);
  nguồn cho `/report`, eval Detail, và so sánh.

## Judge & đánh giá
- **heuristic judge** — judge thuần (hàm), **tất định**; dùng tín hiệu cấu trúc + coverage.
- **single-LLM judge** — judge dùng MỘT mẫu LLM (`--consensus-n 1`), baseline so sánh.
- **consensus judge** — judge bỏ phiếu trên **k mẫu LLM độc lập** (self-consistency), hợp nhất
  bằng chứng static+dynamic; rule `majority | weighted | unanimous-to-flag`. Đóng góp trung tâm.
- **scoreCase** — bộ chấm điểm **site-based**: mỗi site ground-truth → một `Sample`; site sạch
  bị flag ⇒ FP thật; flaw bị bỏ ⇒ FN. (KHÔNG còn count-based.)
- **siteId** — khoá định danh một site (`<caseId>::<siteKey>`) để **ghép cặp** giữa hai run
  cho McNemar.
- **function-mode / line-mode** — chế độ khớp finding với ground-truth: theo **tên hàm** (Juliet)
  hay theo **(file, dòng)** (real_projects).
- **verdict flip rate** — tỉ lệ ca có chữ ký nhầm-lẫn (tp,fp,fn,tn) **đổi** giữa các run; đo
  dao động run-to-run của judge.
- **modal agreement** — trung bình (mẫu trùng-mode / N) trên mỗi ca; 1.0 = mọi run đồng ý.

## Tái lập (reproducibility)
- **Tier-1 determinism** — `no_llm` **tất định bit-for-bit**: hai run cho chấm điểm y hệt.
- **Tier-2 reproducibility** — `llm_assisted` báo cáo **mean ± CI** + verdict-stability (vì
  judge LLM dao động cả ở temp=0).
- **stable-by-luck** — hiện tượng **tổng** confusion trùng giữa hai run **do may** trong khi
  verdict từng ca vẫn dao động (các đảo triệt tiêu trong tổng).
- **deterministic dynamic recipe** — `runDeterministicDynamic`: ghim build+run sanitizer,
  **không có LLM trong vòng chạy** → coverage tất định.
- **FP/KLOC** — số false positive trên 1000 dòng mã thực thi (loại header) — mẫu số chuẩn so
  sánh độ ồn giữa các hệ.

## Chế độ & cờ
- **mode** — `no_llm` (heuristic) | `llm_assisted` (agentic + judge LLM).
- **dynamic** — `off` | `selective` | `aggressive` (mức dùng bằng chứng động).
- **provider** — `local` | `openai` | `anthropic` | `openai-compat` (endpoint OpenAI-tương-thích
  tuỳ chỉnh: base URL + model + key).
- **`--allocators-from`** — `auto|llm|none`: nguồn API cấp phát/giải phóng (LLM khám phá vs cấp tay vs tắt).
- **`--strategy`** — `auto|off`: bật strategist (LLM chọn plan per-project).
- **`STATIC_ENRICH=on`** — bật static-enrichment tất định (điền `staticEvidence` cho judge path-aware).

## Tầng LLM-generalization (POLICY) & engine path-sensitive
- **POLICY vs MECHANISM** — LLM sở hữu *tri-thức-theo-project* (allocator API, ownership, strategy, judge
  calibration); engine tất định sở hữu *cơ học* (parse/CFG/pairing/Z3/scoring). LLM quyết, engine thực thi.
- **allocator profiler** — module LLM đọc repo → `{allocators, deallocators, ownershipNotes}`, **grep-verify**
  (chống hallucinate), cache `<repo>/.cleak/` (`domain/allocatorProfiler.ts`). Thay list hardcode.
- **frozen profile** — profile đông cứng (manifest/committed) dùng trong eval ⇒ tất định; production discover động.
- **strategist** — LLM chọn `{runDynamic, judge, staticDepth}` per-project (`domain/strategist.ts`).
- **judge tuner** — LLM nudge ngưỡng verdict trong **clamp cứng**, production-only (`domain/judgeTuner.ts`).
- **static enrichment** — stage tất định gọi functionSummary+pathConstraints → `bundle.staticEvidence`.
- **path-sensitive leak** — alloc free trên đường chính nhưng MẤT trên đường lỗi/early-return.
- **parameter-ownership leak** — tham số con trỏ free một-số-đường nhưng mất trên đường khác (vd merge_patch).
- **guard-subset reconciliation** — free chỉ reconcile một exit nếu guard nó ⊆ guard exit (path-sensitive).
- **Z3 feasibility** — kiểm SAT `(biến≠0) ∧ guards` để loại leak-path bất khả thi (vd `if(p==NULL) return;`).
  node-only (z3-solver WASM treo dưới Bun).
- **dead-code reachability** — bỏ exit-path sau terminator vô điều kiện (return/goto/exit…) cùng block.
- **ownership notes** — quy ước sở hữu theo project (LLM-discovered) nạp vào prompt judge (vd const-skip).
