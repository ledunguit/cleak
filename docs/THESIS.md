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

1. **Pipeline hybrid tất định-trừ-judge.** Static evidence tất định + recipe
   build+sanitizer ghim (không LLM) + orchestration do LLM planner gate — đây là cấu
   hình **mạnh nhất đo được** trên toàn corpus (F1 0.863/MCC 0.790), rẻ hơn hẳn các
   cấu hình agentic. Đây là novelty trung tâm (thay cho consensus, xem mục 4 bên dưới).
2. **Giao thức tái lập hai tầng (two-tier reproducibility).** Tier-1: chế độ `no_llm`
   **tất định bit-for-bit** (có gate chống "đậu giả"); Tier-2: `llm_assisted` báo cáo
   trung thực **mean ± CI** + **verdict-stability** (tỉ lệ lật verdict) thay vì giấu dao
   động của LLM.
3. **Làm giàu bằng chứng cho judge.** Ownership, cặp alloc→free, đường rò khả thi
   (feasible-leak-path), và **tương quan** runtime↔ứng viên (LINKED vs file-only) — giúp
   judge tất định "path-aware" mà không cần SMT solver.
4. **Consensus judge (self-consistency) — đánh giá trung thực, kết quả đảo ngược theo
   mẫu.** Bỏ phiếu trên *k* mẫu LLM độc lập giúp giảm dao động verdict trên mẫu n=30
   *không stratify* (vô tình 100% 1 family) — nhưng khi lặp lại đúng thí nghiệm trên mẫu
   n=50 **stratified** (đại diện đủ 10 family), hiệu ứng **đảo ngược**: single-LLM ổn
   định hơn (flip 2.0% so với 8.0%) và chính xác hơn (F1 ~0.854 so với ~0.795) trên cả 2
   campaign độc lập (2026-08-19,
   `results/consensus-ablation-n50-2026-08-19/`). Đây là phát hiện phương pháp luận quan
   trọng (stratified sampling ảnh hưởng đến việc đánh giá kỹ thuật LLM-judge, không chỉ
   đánh giá hệ thống cuối) — báo cáo trung thực thay vì chỉ giữ số liệu thuận lợi. Không
   khuyến nghị bật consensus mặc định dựa trên bằng chứng hiện tại.

→ Chi tiết + bàn luận trung thực (gồm cả kết quả negative): [CONTRIBUTION.md](CONTRIBUTION.md).

---

## 4. Kết quả chính

Trên **Juliet CWE-401** (corpus **đã validate**, 1658 ca, content-hash `f578c3ee…`; xem
[EVALUATION.md §8](EVALUATION.md)), số liệu **thực** đã chạy trong dự án:

| Hạng mục | Kết quả |
|---|---|
| **9-baseline ablation** (`configs/baselines/`, stratified n=50) | **B6a** (planner + recipe tất định + LLM judge) thắng: **F1 0.938** (P0.973/R0.906) — vượt B1 static-only (F1 0.792), B3 rule-ensemble (F1 0.857), và các cấu hình agentic B6b/B7 (F1 0.929, tốn ~9× token); xem [EVALUATION §3b](EVALUATION.md) |
| **Full-corpus (1658 ca, static + heuristic, dynamic off)** | P0.680/R0.556/F1 0.612 — **thấp hơn mẫu n=50**, do 2 family yếu bị mẫu stratified pha loãng: C++ `new`/`delete` (R 16.7% trên 1736 site) và `malloc` (P 36.7%, FP cao). Bảng 9-config đầy đủ trên toàn corpus (dynamic bật, 3 lần chạy/config) **đã hoàn thành** (`deepseek-v4-flash`, xem [EVALUATION §3b-bis](EVALUATION.md)) — **B6a thắng: F1 0.863/MCC 0.790**, verify lại được từ artifact local `results/baseline-sweep-2026-08-15T08-28-06/` |
| **Consensus: kết quả đảo ngược theo cách lấy mẫu** | n=30 không stratify (vô tình 100% 1 family): flip rate 13–27% → 6.7%, có vẻ consensus thắng. n=50 stratified (đại diện 10 family, 2026-08-19): **đảo ngược** — single-LLM ổn định hơn (2.0% vs 8.0%) và chính xác hơn (F1 ~0.854 vs ~0.795); không khuyến nghị bật consensus mặc định. Xem [EVALUATION §7](EVALUATION.md) |
| **Tier-1 tất định** | hai lần chạy `no_llm` cho **kết quả chấm điểm y hệt** |

> **Lưu ý (đối chiếu 2026-08):** số liệu trước đây trên bản 30-ca (F1 0.853, P0.806/R0.906)
> được đo trên **corpus có lỗi** (422/1984 ca C++ không build được, bị loại âm thầm khỏi
> confusion matrix) — đã **loại bỏ, không còn trích dẫn**. Bảng trên là số liệu trên corpus
> đã validate (1658 ca, 0 quarantined).

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
