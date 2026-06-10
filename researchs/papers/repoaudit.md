# RepoAudit — Autonomous LLM-Agent for Repository-Level Code Auditing

> ⭐⭐⭐⭐ Analogue cho **orchestration + judge/validator** của leak-investigator.

## Định danh
- **Tiêu đề:** *RepoAudit: An Autonomous LLM-Agent for Repository-Level Code Auditing*
- **Venue / Năm:** **ICML 2025 (poster)** — có bản ghi OpenReview
- **Peer-review:** 🟡 Poster (phản biện nhẹ hơn full paper)
- **arXiv:** 2501.18160

## Kỹ thuật
**Agentic / autonomous LLM-agent:**
- **Agent memory** — khám phá codebase **theo nhu cầu**, phân tích **data-flow facts** dọc các **đường đi chương trình khả thi** trong từng hàm.
- **Validator module** — giảm hallucination bằng cách **kiểm chứng data-flow fact** + **kiểm tra tính thoả (satisfiability) của path condition** ⇒ **giảm false positive**.

→ Ánh xạ trực tiếp tới **control plane orchestration + judge layer** (verdict/validate) của leak-investigator.

## LLM dùng
- **Claude 3.5 Sonnet**.

## Phạm vi defect (đã verify)
- **NPD** (null pointer deref), **ML** (memory leak), **UAF** (use-after-free) — thuộc **CWE Top 25**.
- ⚠️ **ĐÃ BỊ BÁC BỎ (0-3):** RepoAudit **KHÔNG** bao phủ **double-free**, và **KHÔNG** nhắm "**C/C++ specifically**" — nó **đa ngôn ngữ**. Scope đúng: **ML/UAF/NPD**, C/C++ **trong số nhiều ngôn ngữ**.

## Metrics (đã verify 3-0)
- **40 bug thật** trên **15 dự án thực**.
- **Precision = 78.43%** (40 TP / 11 FP = 40/51).
- Chi phí: trung bình **0.44 giờ** & **$2.54 / dự án**.
- Phát hiện **185 bug mới** (174 đã xác nhận/sửa).
- ⚠️ **Precision 78.43% là TỔNG HỢP** cả ML+UAF+NPD, **không phải leak-only**; **không báo recall / FN**.

## Vai trò làm baseline cho `leak-investigator`
- **So phương pháp orchestration + judge:** validator (path-condition SAT) của RepoAudit ↔ judge layer của leak-investigator.
- **So precision & cost** ($/giờ mỗi dự án) — RepoAudit cung cấp số liệu cost rõ ràng, hiếm gặp.
- **Hạn chế khi so:** precision gộp nhiều loại bug, đa ngôn ngữ → khi trích phải **scope rõ ML-only không có sẵn**.

## Nguồn
- https://arxiv.org/abs/2501.18160
