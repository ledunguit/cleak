# Nguồn, Kiểm chứng & Câu hỏi mở

Phụ lục minh bạch: danh sách nguồn, phương pháp kiểm chứng đối kháng, **các claim bị bác bỏ (KHÔNG được trích dẫn)**, và câu hỏi mở.

---

## 1. Phương pháp kiểm chứng

Quy trình deep-research (5 góc tìm kiếm → fetch → verify đối kháng → synthesize):

- **Góc tìm kiếm (5):** broad/primary · agentic/multi-tool systems · benchmarks/datasets · top-tier venue/academic · repair/verdict output.
- **Thống kê:** 19 nguồn fetch · **91 claim** trích xuất · **25 claim** đưa vào kiểm chứng · **19 confirmed** · **6 killed** · 7 finding sau tổng hợp.
- **Kiểm chứng đối kháng:** mỗi claim được 3 agent độc lập cố **bác bỏ**; cần **≥ 2/3 phiếu bác bỏ** để loại. Ký hiệu "3-0 ✓" = cả 3 phiếu xác nhận; "0-3 ✗" = cả 3 bác bỏ.

> ⚠️ **Giới hạn:** đây là tổng hợp tự động. Nhiều nguồn là **tiền ấn phẩm arXiv 2026 rất mới**; arXiv ID, ngày, venue và số liệu **phải được tái kiểm từ PDF gốc** trước khi đưa vào luận văn.

---

## 2. Danh sách nguồn (đã fetch)

### Nguồn tạo ra finding được xác nhận

| Công trình | URL | Góc |
|---|---|---|
| MemHint | https://arxiv.org/abs/2603.27224 (HTML: /html/2603.27224v3) | broad/primary, repair/verdict |
| RepoAudit | https://arxiv.org/abs/2501.18160 | broad/primary |
| LAMeD | https://arxiv.org/abs/2505.02376 · https://dl.acm.org/doi/full/10.1145/3756681.3756999 | broad/primary, agentic |
| POM (CMU SEI) | https://www.sei.cmu.edu/projects/ai-powered-memory-safety-for-c-applications/ | broad/primary |
| SecVulEval | https://arxiv.org/pdf/2505.19828 | broad/primary |
| FuzzingBrain V2 | https://arxiv.org/html/2605.21779v1 | agentic/multi-tool |
| (Loại trừ) ICSE 2025 Java | https://conf.researchr.org/details/icse-2025/llm4code-2025-papers/15/ | broad/primary |

### Nguồn phụ đã fetch nhưng CHƯA chuyển thành finding xác nhận

> Các URL này xuất hiện trong quá trình fetch nhưng **không** sinh claim được verify thành baseline. Liệt kê để **điều tra thêm thủ công** — chưa kiểm chứng, đừng trích vội.

| URL | Góc | Ghi chú |
|---|---|---|
| https://arxiv.org/pdf/2503.09433 | benchmarks/datasets | Cần kiểm tra liên quan |
| https://dl.acm.org/doi/10.1109/ICSE55347.2025.00038 | benchmarks/datasets | ICSE 2025 — đáng xem |
| https://dl.acm.org/doi/10.1109/ICSE55347.2025.00131 | top-tier venue | ICSE 2025 — đáng xem |
| https://arxiv.org/abs/2504.04422 (HTML v1) | top-tier venue / repair | Chưa verify |
| https://www.dcs.gla.ac.uk/~jsinger/pdfs/ismm25.pdf | repair/verdict | **ISMM 2025** (memory mgmt) — đáng xem cho góc leak |
| https://conf.researchr.org/details/icst-2026/iteqs-2026-papers/1/ | repair/verdict | **ICST 2026** "Friends or Foes: Combining Static Analysis Tools and LLMs for Vulnerability Detection" — liên quan trực tiếp chủ đề, **nên đọc** |
| https://arxiv.org/pdf/2506.11791 | repair/verdict | Chưa verify |
| https://arxiv.org/abs/2604.06633 | agentic | **"Argus"** — claim bị bác bỏ (xem dưới), KHÔNG dùng |

---

## 3. ⛔ Các claim BỊ BÁC BỎ — KHÔNG trích dẫn

> Đây là phần quan trọng nhất để tránh trích sai số liệu trong luận văn.

| # | Claim bị bác bỏ | Phiếu | Nguồn | Hệ quả |
|---|---|---|---|---|
| 1 | MemHint: "trên **8 dự án** C/C++ (**3.6M LOC**) tìm **54 leak** (53 confirmed)…" | 1-2 ✗ | 2603.27224 | **Dùng số đúng:** ~52–54 leak / **7 dự án** / **3.4M+ SLOC** / 49 confirmed / 4 CVE |
| 2 | RepoAudit phát hiện ML + UAF + NPD **+ double-free** | 0-3 ✗ | 2501.18160 | RepoAudit **KHÔNG** bao phủ double-free |
| 3 | RepoAudit nhắm "**C/C++ specifically**" | 0-3 ✗ | 2501.18160 | RepoAudit là **đa ngôn ngữ**, không chỉ C/C++ |
| 4 | POM: precision **99.84%** / recall **83.51%** | 0-3 ✗ | SEI | **KHÔNG** dùng các con số này làm metric baseline |
| 5 | "Argus là framework multi-agent **đầu tiên** chuyên cho phát hiện vuln…" | 0-3 ✗ | 2604.06633 | **KHÔNG** trích Argus như baseline |
| 6 | Argus kết hợp agentic + RAG + ReAct, tích hợp SAST… | 1-2 ✗ | 2604.06633 | **KHÔNG** trích Argus |

**Claim mức "thận trọng" (2-1 — pass nhưng yếu):**
- POM được eval trên Juliet C/C++ phủ CWE-401/415/416 → **2-1 ✓** (chấp nhận nhưng nên xác nhận lại từ tech report CMU/SEI-2025-TR-008).

---

## 4. Câu hỏi mở (cần giải quyết trước khi nộp)

1. **Peer-review status của MemHint (2603.27224) & FuzzingBrain V2 (2605.21779):** đã được chấp nhận ở venue top (ICSE/FSE/ASE/ISSTA/S&P/USENIX) chưa, hay vẫn preprint? → quyết định có baseline agentic/neuro-symbolic **đã phản biện** không.
2. **Recall / FN cho riêng tập memory-leak** của RepoAudit, MemHint, FuzzingBrain V2 (không phải metric tổng hợp) → để so leak-only P/R/F1 thay vì số gộp nhiều loại bug.
3. **Có baseline static+dynamic chuyên leak không?** FuzzingBrain V2 là hệ static+dynamic agentic duy nhất tìm thấy, nhưng ưu tiên lỗi gây crash — **một baseline static+dynamic thật sự cho LEAK có thể không tồn tại** (→ research gap của leak-investigator).
4. **Benchmark dùng chung để so head-to-head:** Juliet/SARD (POM, synthetic), DiverseVul (LAMeD), dự án thực của MemHint, hay SecVulEval? Chưa có cái nào **purpose-built** cho đánh giá memory-leak.

---

## 5. Nhạy cảm thời gian

- Hai analogue kiến trúc mạnh nhất (**MemHint**, **FuzzingBrain V2**) là **preprint 2026** — venue/peer-review/metrics **có thể thay đổi**; **tái kiểm trước khi nộp**.
- arXiv ID dạng `2603.*`, `2605.*`, `2604.*` ứng với 03–05/2026 — kiểm tra lại định danh chính xác (đôi khi có bản v2/v3 cập nhật số liệu).

---

## 6. Thống kê quy trình

| Chỉ số | Giá trị |
|---|---|
| Góc tìm kiếm | 5 |
| Nguồn fetch | 19 |
| Claim trích xuất | 91 |
| Claim kiểm chứng | 25 |
| Confirmed | 19 |
| Killed | 6 |
| Finding sau tổng hợp | 7 |
| URL trùng lặp loại bỏ | 9 |
| Agent calls | 101 |

*Tổng hợp bởi quy trình deep-research, 2026-06-09.*
