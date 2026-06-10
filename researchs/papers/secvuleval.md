# SecVulEval — Benchmark CVE C/C++ thực tế (dataset, không phải detector)

> ⭐⭐ **Dataset đánh giá** cho phát hiện vuln C/C++. Không leak-specific.

## Định danh
- **Tiêu đề:** *SecVulEval: Benchmarking LLMs for Real-World C/C++ Vulnerability Detection*
- **Tác giả:** Ahmed, Harzevili, Shin, Pham, Wang
- **Venue / Năm:** arXiv (2025) — thực chất là **submission ICLR 2026 ĐÃ RÚT** (OpenReview 0A3qzLmRHd)
- **Peer-review:** ❌ **Chưa** (preprint, đã rút khỏi ICLR 2026)
- **arXiv:** 2505.19828

## Bản chất
**Benchmark / dataset** — *không* phải hệ thống phát hiện. Dùng để **đánh giá năng lực của các LLM khác** trên phát hiện vuln C/C++ thực tế.

## Quy mô & Đặc trưng (đã verify 3-0)
- **25,440 mẫu hàm** — 10,998 vulnerable + 14,442 non-vulnerable.
- **5,867 CVE** duy nhất.
- **707 dự án C/C++** thực tế (1999–2024).
- **145 loại CWE** — gồm **CWE-416 (UAF)**, **CWE-476 (null deref)**, …
- **Chú thích statement-level** (không chỉ binary cấp hàm) → đánh giá định vị chính xác, vượt phân loại nhị phân.

## Phạm vi
- **C/C++:** ✅ (benchmark).
- **Memory leak chuyên biệt:** ❌ — memory-safety chỉ là **tập con** trong 145 CWE; **không** purpose-built cho leak.

## Vai trò làm baseline/dataset cho `leak-investigator`
- **Dataset đánh giá** cho phần phát hiện vuln C/C++ — đặc biệt nếu leak-investigator mở rộng sang **UAF / null-deref**.
- Có thể **lọc tập con CWE liên quan memory-safety/leak** để dùng làm tập test.
- Chú thích **statement-level** hữu ích để đánh giá khả năng định vị chính xác dòng leak.

## ⚠️ Lưu ý
- **Chưa peer-review** (preprint, ICLR 2026 đã rút) — trình bày là "recent benchmark" kèm caveat.
- **Không** dùng để claim baseline leak-only; chỉ là **nguồn dữ liệu đánh giá tổng quát**.

## Nguồn
- https://arxiv.org/pdf/2505.19828
