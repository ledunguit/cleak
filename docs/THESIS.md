# Luận văn — LLM điều phối điều tra rò rỉ bộ nhớ cho C/C++

> **Đọc trước.** Đây là bản tổng quan "một trang" của luận văn: bài toán, hệ thống,
> đóng góp học thuật, kết quả chính, và bản đồ dẫn xuống các tài liệu chi tiết. Tài
> liệu kỹ thuật (kiến trúc, prompt, đánh giá, bảo mật) giữ nguyên tiếng Anh; các tài
> liệu học thuật/vận hành mới viết tiếng Việt.

---

## 1. Bài toán & động lực

Rò rỉ bộ nhớ (memory leak, CWE-401) trong C/C++ là lớp lỗi không gây crash: chương
trình vẫn chạy nhưng tiêu hao bộ nhớ dần, khó phát hiện bằng test thông thường.

- **Công cụ static** (Clang Static Analyzer, Infer, CodeQL) báo ứng viên nhưng **nhiều
  false positive** do phân tích đường đi không đầy đủ.
- **Công cụ dynamic** (Valgrind Memcheck, AddressSanitizer/LeakSanitizer) cho bằng
  chứng chắc chắn nhưng **chỉ thấy đường đã chạy** (cần input kích hoạt).
- Cả hai chỉ cho ra *cảnh báo*, không giải thích **vì sao** rò rỉ và **sửa thế nào**.

**Ý tưởng luận văn:** để một **LLM điều phối** một vòng lặp điều tra — chọn công cụ
phân tích nào chạy tiếp theo, hợp nhất bằng chứng static + dynamic, rồi một **tầng
judge** sinh **verdict + giải thích root-cause + diff sửa lỗi** — thay vì chỉ liệt kê
cảnh báo. Vòng lặp 3 pha: **discovery → investigation loop → judging/reporting**.

---

## 2. Hệ thống trong một trang

Monorepo (Turborepo) với **một đường điều phối** (CLI/TUI) dùng chung bộ phân tích + scorer:

| Đường | Thành phần | Mô hình LLM | Dùng khi |
|---|---|---|---|
| **CLI/TUI** | `apps/leak-inspector-tui` + `packages/agent-core` | Native tool-calling | Quét nhanh, **eval/benchmark**, tái lập |

> Bản hiện thực web (control-plane + React UI) được lưu trên nhánh git `web-implementation`; master nay chỉ còn đường TUI.

Bộ phân tích (phục vụ MCP/HTTP cho TUI — transport duy nhất; mã gRPC/`proto` đã gỡ):
- **`apps/static-analyzer`** — index file, candidate/AST scan, call-graph, interprocedural
  flow, và một lượt **Clang `scan-build`** (slot "deep static", tự chứa — *không* còn
  submodule LeakGuard).
- **`apps/dynamic-analyzer`** — build có sanitizer, chạy Valgrind/ASan/LSan, chuẩn hoá báo cáo.

Tầng tri thức chung: **`packages/common`** (types/Zod schema/`scoreCase`/judges/reporting).
Tầng judge có **3 cấu hình** so sánh được như-nhau: **heuristic** (thuần, tất định) ·
**single-LLM** · **consensus** (bỏ phiếu k mẫu, hợp nhất static+dynamic).

→ Chi tiết: [ARCHITECTURE.md](ARCHITECTURE.md) (thành phần, giao thức, pipeline),
[sequence-diagrams.md](sequence-diagrams.md) (luồng runtime), [PROMPTS.md](PROMPTS.md)
(mọi prompt LLM).

---

## 3. Đóng góp học thuật (tóm tắt)

1. **Consensus judge — hợp nhất static+dynamic + self-consistency.** Một judge bỏ phiếu
   trên *k* mẫu LLM độc lập, hợp nhất hai trục bằng chứng (static / dynamic) để giảm dao
   động verdict trên ca biên. Đây là novelty trung tâm.
2. **Giao thức tái lập hai tầng (two-tier reproducibility).** Tier-1: chế độ `no_llm`
   **tất định bit-for-bit** (có gate chống "đậu giả"); Tier-2: `llm_assisted` báo cáo
   trung thực **mean ± CI** + **verdict-stability** (tỉ lệ lật verdict) thay vì giấu dao
   động của LLM.
3. **Tất định hoá tầng dynamic.** "Recipe" build+run được ghim (không có LLM trong vòng
   *chạy*) + **capture bằng chứng tất định** + trạng thái `dynamicCoverage` trung thực
   (`exercised_clean | exercised_leak | not_exercised | dynamic_off`).
4. **Làm giàu bằng chứng cho judge.** Ownership, cặp alloc→free, đường rò khả thi
   (feasible-leak-path), và **tương quan** runtime↔ứng viên (LINKED vs file-only).

→ Chi tiết + bàn luận trung thực (gồm cả kết quả negative): [CONTRIBUTION.md](CONTRIBUTION.md).

---

## 4. Kết quả chính

Trên **Juliet CWE-401** (corpus 1984 ca; các phép đo dưới đây trên 30 ca, analyzer chạy
qua MCP Docker), số liệu **thực** đã chạy trong dự án:

| Hạng mục | Kết quả |
|---|---|
| **Hệ thống thắng baseline static** | no_llm heuristic **F1 0.853** (P0.806/R0.906) **>** Clang Static Analyzer **F1 ≈0.76** |
| **Consensus giảm dao động ~4×** | tỉ lệ lật verdict **26.7% → 6.7%**; case-stability **73.3% → 93.3%** (n=1 vs n=3) |
| **Tier-1 tất định** | hai lần chạy `no_llm` cho **kết quả chấm điểm y hệt** (TP29 FP7 FN3 TN38) |

→ Phương pháp đầy đủ (scoring site-based, bootstrap CI, McNemar, hai tầng tất định):
[EVALUATION.md](EVALUATION.md). Cách chạy so sánh baseline: [BASELINE-COMPARISON.md](BASELINE-COMPARISON.md).

---

## 5. Định vị so với SOTA

Khảo sát 2025–2026 (xem [RELATED-WORK.md](RELATED-WORK.md), distill từ `researchs/`):

- **Baseline leak C/C++ trực tiếp:** **MemHint** (neuro-symbolic LLM+Z3) và **LAMeD**
  (EASE 2025, sinh annotation) — đều **static-only**; LAMeD minh hoạ rõ đánh đổi
  recall↑/FP↑ mà consensus judge nhắm giải quyết.
- **Analogue kiến trúc (agentic + judge + static/dynamic + MCP):** **FuzzingBrain V2**,
  **RepoAudit**, và cụm AIxCC (**ATLANTIS**, **Buttercup**) — nhưng đều xác minh qua
  **crash sanitizer** (UAF/double-free), không phải lớp **non-crash leak**.
- **Research gap:** chưa tìm thấy hệ nào **kết hợp static + dynamic (Valgrind/ASan/LSan)
  chuyên cho memory-LEAK** trong C/C++ → đây là vị trí định vị của luận văn: mang mô
  hình agentic static+dynamic từ lỗi-gây-crash sang lớp **rò rỉ không crash**, với judge
  hợp nhất bằng chứng + giải thích + diff sửa.

---

## 6. Bản đồ tài liệu

| Đọc theo thứ tự | Tài liệu | Nội dung |
|---|---|---|
| 1 | **THESIS.md** (file này) | Tổng quan đọc-trước |
| 2 | [CONTRIBUTION.md](CONTRIBUTION.md) | Đóng góp/tính học thuật chi tiết + bàn luận |
| 3 | [RELATED-WORK.md](RELATED-WORK.md) | Baseline & related work (paper so sánh) |
| 4 | [EVALUATION.md](EVALUATION.md) | Phương pháp đánh giá + tái lập (EN) |
| 5 | [BASELINE-COMPARISON.md](BASELINE-COMPARISON.md) | Runbook chạy so sánh baseline |
| 6 | [OPERATIONS.md](OPERATIONS.md) | Vận hành & tái lập kết quả end-to-end |
| 7 | [ARCHITECTURE.md](ARCHITECTURE.md) · [sequence-diagrams.md](sequence-diagrams.md) · [PROMPTS.md](PROMPTS.md) | Kiến trúc, luồng, prompt (chi tiết kỹ thuật) |
| — | [GLOSSARY.md](GLOSSARY.md) · [DATASETS.md](DATASETS.md) · [SECURITY.md](SECURITY.md) · [GOAL.md](GOAL.md) | Thuật ngữ, dữ liệu, bảo mật, mục tiêu |

Xem [docs/README.md](README.md) cho mục lục đầy đủ.
