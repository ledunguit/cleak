# Researchs — LLM cho phát hiện Memory Leak trong C/C++ (2025–2026)

Thư mục này tổng hợp kết quả nghiên cứu về các công trình **uy tín, có phản biện (peer-review) / tiền ấn phẩm được cross-review** trong **2025–2026** sử dụng **LLM để phát hiện lỗ hổng bộ nhớ (memory leak và các lỗi memory-safety liên quan: use-after-free, double-free, missing-free) trong C/C++**.

Mục tiêu: chọn ra **baseline so sánh** phù hợp cho **`leak-investigator`** — hệ thống điều phối bằng LLM kết hợp:
- **Static analysis** (MCP server bọc Clang Static Analyzer / LeakGuard), và
- **Dynamic analysis** (Valgrind Memcheck, AddressSanitizer, LeakSanitizer),
- điều phối bởi một **control plane** trung tâm với một **judge layer** sinh verdict + đề xuất sửa lỗi.

> ⚠️ **Lưu ý độ tin cậy.** Báo cáo này được sinh tự động qua một quy trình deep-research (fan-out web search → fetch nguồn → kiểm chứng đối kháng 3 phiếu/claim). Các số liệu dưới đây đã được verify 3-0, nhưng **vài công trình là tiền ấn phẩm arXiv rất mới (2026)** — hãy **kiểm chứng lại venue, peer-review status và số liệu chính xác từ bản PDF gốc trước khi trích dẫn trong luận văn**. Các con số **đã bị bác bỏ** (không được dùng) được liệt kê tường minh trong `04-nguon-va-kiem-chung.md`.

---

## Bảng xếp hạng nhanh các baseline

| # | Công trình | Năm | Peer-review | Chiều kiến trúc khớp với leak-investigator | Memory leak là trọng tâm? | Mức độ phù hợp làm baseline |
|---|---|---|---|---|---|---|
| 1 | **MemHint** | 2026 | ❌ arXiv | Static + LLM (neuro-symbolic, LLM+Z3) | ✅ Có | ⭐⭐⭐⭐⭐ Trực tiếp nhất về defect + ngôn ngữ |
| 2 | **LAMeD** | 2025 | ✅ EASE 2025 (CORE-A) | Static + LLM (annotation generation) | ✅ Có | ⭐⭐⭐⭐⭐ Baseline peer-reviewed mạnh nhất |
| 3 | **RepoAudit** | 2025 | 🟡 ICML 2025 poster | Agentic + judge/validator | 🟡 Có (ML/UAF/NPD, không phải trọng tâm) | ⭐⭐⭐⭐ Tương đồng về orchestration + judge |
| 4 | **FuzzingBrain V2** | 2026 | ❌ arXiv | Multi-agent + MCP + **Static + Dynamic** | 🔶 Phụ (chủ yếu crash/UAF/double-free) | ⭐⭐⭐⭐ Analogue kiến trúc gần nhất |
| 5 | **POM (CMU SEI)** | 2025 | ❌ SEI Tech Report | LLM + SAT (formal, prevention) | 🔶 Phụ (CWE-401 trong Juliet) | ⭐⭐ Baseline phụ trợ |
| 6 | **SecVulEval** | 2025 | ❌ arXiv (ICLR 2026 đã rút) | — (đây là **dataset**, không phải detector) | ❌ Không (vuln tổng quát) | ⭐⭐ Dataset đánh giá phụ |

> ❌ **Loại trừ:** ICSE 2025 LLM4Code *"With a Little Help from My (LLM) Friends"* — chỉ nhắm **Java** (garbage-collected) + OWASP Benchmark, **không có C/C++, không memory leak**. Đưa vào để minh bạch, **không dùng làm baseline**. Xem `papers/_excluded-icse2025-java.md`.

---

## Cấu trúc thư mục

| File | Nội dung |
|---|---|
| `README.md` | (file này) Tổng quan + bảng xếp hạng + điều hướng |
| `01-bao-cao-tong-hop.md` | **Báo cáo tổng hợp chính**: phân tích từng baseline theo chiều kiến trúc của leak-investigator, khuyến nghị thiết kế thực nghiệm |
| `02-bang-so-sanh-baselines.md` | Bảng so sánh chi tiết tất cả tiêu chí (LLM, kỹ thuật, dataset, metrics, C/C++, leak coverage) |
| `03-benchmarks-datasets.md` | Các benchmark/dataset cho memory-leak / vuln C/C++ (SecVulEval, Juliet, DiverseVul, cJSON…) |
| `04-nguon-va-kiem-chung.md` | Danh sách nguồn, phương pháp kiểm chứng, **các claim bị bác bỏ (không trích dẫn)**, câu hỏi mở |
| `05-baseline-kien-truc.md` | **Baseline KIẾN TRÚC** (static+dynamic+MCP+judge): FuzzingBrain V2 vs cụm AIxCC CRS (ATLANTIS, Buttercup…) — khớp nhất nhưng không duy nhất |
| `papers/` | Phiếu chi tiết từng công trình (1 file/paper) |

### Phiếu chi tiết từng paper (`papers/`)

| File | Công trình |
|---|---|
| `papers/memhint.md` | MemHint — neuro-symbolic LLM+Z3, memory leak C/C++ |
| `papers/lamed.md` | LAMeD — LLM-generated annotations, EASE 2025 |
| `papers/lamed-reproducibility.md` | **LAMeD — đánh giá khả năng reproduce** (artifact Zenodo, Cooddy, models, kế hoạch repro) |
| `papers/repoaudit.md` | RepoAudit — autonomous LLM-agent auditing |
| `papers/fuzzingbrain-v2.md` | FuzzingBrain V2 — multi-agent MCP static+dynamic |
| `papers/pom-cmu-sei.md` | POM — Pointer Ownership Model (CMU SEI), LLM+SAT |
| `papers/secvuleval.md` | SecVulEval — benchmark 25,440 hàm C/C++ |
| `papers/_excluded-icse2025-java.md` | (Loại trừ) ICSE 2025 LLM4Code — Java only |

---

## TL;DR cho luận văn

1. **Baseline trực tiếp nhất về memory leak trong C/C++:** **MemHint** (static+LLM neuro-symbolic) và **LAMeD** (static+LLM annotation). Cả hai là *static-only* — `leak-investigator` mở rộng bằng tầng **dynamic** (Valgrind/ASan/LSan) + **judge layer**, nên có thể định vị đóng góp ở chính khoảng trống này.
2. **Analogue kiến trúc gần nhất (agentic + MCP + static+dynamic):** **FuzzingBrain V2** — nhưng nó ưu tiên lỗi gây crash (UAF/double-free/overflow), memory leak chỉ là phụ. **RepoAudit** gần với tầng *orchestration + judge/validator*.
3. **Khoảng trống nghiên cứu (research gap):** **chưa tìm thấy** công trình 2025–2026 nào kết hợp **cả static lẫn dynamic (Valgrind/ASan/LSan) chuyên cho memory-LEAK** trong C/C++ — đây là vị trí định vị mạnh cho `leak-investigator`.
4. **Tập baseline peer-reviewed thực sự rất mỏng:** chỉ **LAMeD** (EASE 2025) đạt peer-review đầy đủ cho bài toán leak C/C++; RepoAudit là poster ICML 2025. Phần còn lại là preprint/tech-report → cân nhắc khi luận văn yêu cầu baseline đã phản biện.

*Nguồn dữ liệu: quy trình deep-research, 19 nguồn fetch, 91 claim trích xuất, 25 claim kiểm chứng đối kháng, 19 confirmed. Ngày tổng hợp: 2026-06-09.*
