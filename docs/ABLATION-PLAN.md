# Kế hoạch: Ablation 7-baseline điều khiển bằng YAML (nội bộ kiến trúc)

> Mục tiêu: biến mỗi thành phần kiến trúc thành **đóng góp đo được**, chạy được bằng cách đổi
> config YAML — thay vì chỉ so với paper ngoài. External comparison thu gọn về **FuzzingBrain V2**
> (so kiến trúc). Thiết kế baseline gốc: [BASELINE_PROPOSED.md](./BASELINE_PROPOSED.md).

## 0. Khung thực nghiệm (chốt)

- **7 baseline** (B1–B7) = ablation 5 năng lực.
- **Corpus chính: Juliet CWE-401, 200–500 ca** → đủ N cho *Precision/Recall/F1* + các *metric hiệu
  năng* (runtime, MCP calls, token). Juliet **có `main()` driver ⇒ chạy được** ⇒ baseline dynamic
  (B2/B5) **chạy được ngay trên Juliet**, không bắt buộc chờ Phase B.
- **Corpus phụ: LAMeD** (ca KHÓ, dự án thật, static-only) → nơi *reasoning (planner/fusion) mới lộ
  giá trị* (Juliet "dễ" → heuristic đã mạnh, fusion có thể không tăng, thậm chí giảm precision —
  đây là *finding trung thực*, phải báo cáo đúng).
- **Metric mỗi baseline:** Precision · Recall · F1 · FP/KLOC · **runtime** · **#MCP calls** ·
  **token cost** (input/output) · #turns. ⇒ trục "chi phí ↔ lợi ích", đúng chất luận văn hệ thống.
- **Case study:** ≥3 ca điển hình (vd: dynamic bắt leak static bỏ sót; planner né dynamic-run vô
  ích; cjson `merge_patch` path-sensitive).

> **Cảnh báo phương pháp — quan trọng:** trong bảng gốc, `planner` và `tool_selector` **chỉ khác
> nhau ở B7** (cả hai cùng OFF ở B1–B6, cùng ON ở B7). Nếu giữ nguyên vậy thì **không thể quy đóng
> góp riêng cho từng trục** (chúng đồng biến). Vì bạn muốn **tách 2 trục**, ta THÊM 2 điểm ablation
> để cô lập: **B6a = +planner** (planner ON, selector OFF) và **B6b = +tool_selector** (planner OFF,
> selector ON), nằm giữa B6 và B7. ⇒ thực chất **9 cấu hình**, vẫn report bảng 7 dòng chính + 2 dòng
> isolation.

## 1. Mô hình năng lực (5 cờ, planner/tool_selector là 2 trục độc lập)

| Cờ | ON nghĩa là | OFF nghĩa là | Cơ chế trong code |
|---|---|---|---|
| `static` | discovery tĩnh (`candidateScan` tìm alloc-site) | **dynamic-only**: synthesize candidate từ stack sanitizer | `scanController` nhánh discovery; OFF = **module MỚI** (Bước 4a) |
| `dynamic` | build + chạy sanitizer (LSan/ASan/Valgrind) | bỏ tầng động | `--dynamic selective/off` · `runDeterministicDynamic` (`dynamicEvidence.ts`) |
| `planner` | `strategist.decideStrategy` chọn `{runDynamic, judge, staticDepth}` theo project | dùng config cứng từ YAML | gate `strategist.ts` |
| `tool_selector` | agentic `queryLoop`: LLM chọn tool từng bước | **recipe tất định**: thứ tự tool cố định | `investigation.ts` (agentic) ↔ recipe cố định |
| `fusion` | LLM evidence fusion (LLM/consensus judge cho borderline) | heuristic judge thuần | `mode=llm_assisted` ↔ `no_llm` (`heuristic-judge.ts`) |

**Luật hợp lệ (Zod refinement):**
- `static=false && dynamic=false` → **invalid** (không có gì để phát hiện).
- `tool_selector=true` ⇒ `fusion=true` (selector là LLM-driven → cần LLM).
- `planner=true` ⇒ `fusion=true` (planner là LLM).
- `dynamic=true` ⇒ cần corpus chạy-được (runtime check; cảnh báo + skip ca không build được).

**7 baseline (+2 isolation) dưới dạng vector `[static,dynamic,planner,tool_selector,fusion]`:**

| ID | Tên | static | dynamic | planner | tool_sel | fusion |
|---|---|:-:|:-:|:-:|:-:|:-:|
| B1 | Static only | ✅ | ❌ | ❌ | ❌ | ❌ |
| B2 | Dynamic only | ❌ | ✅ | ❌ | ❌ | ❌ |
| B3 | Rule-based ensemble | ✅ | ✅ | ❌ | ❌ | ❌ |
| B4 | LLM + static | ✅ | ❌ | ❌ | ❌ | ✅ |
| B5 | LLM + dynamic | ❌ | ✅ | ❌ | ❌ | ✅ |
| B6 | LLM + all (no planner/sel) | ✅ | ✅ | ❌ | ❌ | ✅ |
| **B6a** | **+ planner only** | ✅ | ✅ | ✅ | ❌ | ✅ |
| **B6b** | **+ tool_selector only** | ✅ | ✅ | ❌ | ✅ | ✅ |
| B7 | Proposed (full adaptive) | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## 2. Bốn bước triển khai

### Bước 1 — `BaselineConfig` schema + YAML loader  *(size: S)*
- **MỚI** `apps/leak-inspector-tui/src/domain/baselineConfig.ts`: Zod schema
  `{ id, name, description, capabilities: {static,dynamic,planner,tool_selector,fusion}, corpus?, consensusN?, runs? }`
  + `validateCapabilities()` (luật hợp lệ §1) + `loadBaselineConfig(path)`.
- **MỚI** `configs/baselines/*.yaml` (b1…b7 + b6a/b6b). Thêm dep **`yaml`** (chưa có) vào TUI.
- **Test:** `baselineConfig.test.ts` — parse 9 file, reject combo invalid (vd `tool_selector` không
  `fusion`), reject `static=dynamic=false`.

### Bước 2 — Capability resolver  *(size: S–M)*
- **MỚI** `apps/leak-inspector-tui/src/domain/capabilityResolver.ts`:
  `resolveCapabilities(caps) → { mode, dynamic, planner, agentic, enrich, consensusN }`
  ánh xạ tên học-thuật → công tắc engine đang có:
  - `fusion` → `mode` (`llm_assisted` | `no_llm`)
  - `dynamic` → `'selective' | 'off'`
  - `planner` → bật/bypass `strategist`
  - `tool_selector` → `agentic` (queryLoop) | recipe tất định
  - `static` → bật/tắt nhánh discovery tĩnh (OFF cần Bước 4a)
- Thuần hàm ⇒ **test toàn bộ 9 config → knob mong đợi** (`capabilityResolver.test.ts`).
- Wire vào `scanController`/`headless` qua một `RunPlan` thay cho việc đọc cờ rải rác.

### Bước 3 — Sweep runner + instrumentation  *(size: M)*
- **MỚI** `scripts/run-baselines.ts`: `--baselines configs/baselines --corpus demo/juliet_cwe401
  --limit 300` → mỗi YAML: resolve → chạy `runCorpusEval` → gom metric → in **1 bảng** (md + CSV +
  LaTeX, tái dùng pattern `compare-results.ts`).
- **Instrumentation còn thiếu = #MCP calls.** `scanMetrics.ts` đã có token/runtime/turns; thêm
  **counter callTool**: wrap ở `agent-core/mcp/mcpClient.ts` (hoặc `mcpToolAdapter.ts`) → đẩy
  `mcp_calls` vào `ScanMetricsContext`/`ScanMetrics`. (no_llm: token=0, MCP calls = candidateScan/file
  + functionSummary/pathConstraints/candidate — đếm được, tất định.)
- **Determinism:** config `fusion=false` chạy 1 lần (tất định); `fusion=true` chạy `runs=K` →
  report mean ± std (tái dùng variance reporting có sẵn trong `evaluate-corpus.ts`).
- **Test:** aggregation + bảng (snapshot test trên fixture metrics).

### Bước 4 — Năng lực MỚI (phần "không miễn phí")  *(size: L)*
- **4a. Dynamic-only discovery (`static=false` → B2/B5).** Hiện discovery do static lái; dynamic chỉ
  *gắn evidence*. Cần module synthesize `LeakCandidate/LeakBundle` **từ stack LSan/Valgrind** (không
  có candidate tĩnh). **MỚI** `domain/dynamicDiscovery.ts` (parse leak stack → candidate site) + nhánh
  trong `scanController`. Cần corpus chạy-được (Juliet runnable + Phase B).
- **4b. Tách `planner` ⊥ `tool_selector`.** Hiện `queryLoop` gộp cả lập-kế-hoạch lẫn chọn-tool. Cần:
  (i) cho phép `planner=true, tool_selector=false` = strategist quyết chiến lược **nhưng** thực thi
  bằng **recipe tất định** (không agentic); (ii) `planner=false, tool_selector=true` = không strategist,
  agentic phản ứng. ⇒ refactor `investigationPhase` nhận `{planner, agentic}` riêng. Đây là điều kiện
  để B6a/B6b/B7 có nghĩa.

**Thứ tự ưu tiên:** Bước 1→2→3 ra ngay **B1, B3, B4, B6** (chỉ re-wire cờ cũ) + đo đủ metric. Bước 4a
mở khoá B2/B5; Bước 4b mở khoá B6a/B6b/B7 (isolation 2 trục).

---

## 3. External comparison — FuzzingBrain V2 (phạm vi)

FBv2 là baseline **kiến trúc** (agent AIxCC), **không phải leak-detector chạy được trên corpus ta**
⇒ so sánh ở mức **feature/architecture matrix + số đã báo của họ**, KHÔNG phải P/R/F1 cùng-corpus
(trừ khi artifact của họ chạy được — cần kiểm chứng trước khi hứa số). Ghi rõ caveat này khi viết.

## 4. Rủi ro / trung thực

- Juliet "dễ": fusion/planner có thể **không** cải thiện (hoặc giảm precision như consensus đã thấy)
  → vẫn báo cáo đúng; dùng LAMeD để cho thấy chỗ reasoning có giá trị.
- `dynamic=true` cần build được từng ca — gate sanity (buggy→leak đúng site, fixed→sạch) trước khi chấm.
- Tách planner/tool_selector (4b) là refactor thật, không phải cờ — đừng hứa "free".

## 5. Verification
- 9 YAML parse + validate (reject combo invalid).
- Resolver: 9 config → knob đúng (unit test toàn bộ).
- Sweep ra **1 bảng** P/R/F1/FP-KLOC/runtime/#MCP/token cho B1,B3,B4,B6 trên Juliet (≥200 ca).
- `no_llm` (fusion=false) **tái lập** (2 lần khớp) ⇒ Tier-1 determinism giữ nguyên.
- B2/B5 (sau 4a): buggy→LSan leak đúng site; B6a/B6b/B7 (sau 4b) phân biệt được đóng góp planner ⊥ selector.
