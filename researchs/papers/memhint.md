# MemHint — Neuro-Symbolic Augmented Static Analysis cho Memory Leak C/C++

> ⭐⭐⭐⭐⭐ **Baseline trực tiếp nhất** về defect class (memory leak) + ngôn ngữ (C/C++).

## Định danh
- **Tiêu đề:** *Finding Memory Leaks in C/C++ Programs via Neuro-Symbolic Augmented Static Analysis*
- **Tác giả:** Huang, Shi, B. Wang, Z. Yang, D. Lo
- **Venue / Năm:** arXiv (2026) — **tiền ấn phẩm, chưa peer-review**
- **arXiv:** 2603.27224 (HTML: arxiv.org/html/2603.27224v3)

## Kỹ thuật
Pipeline **neuro-symbolic** kết hợp:
1. **LLM hiểu ngữ nghĩa code:** phân loại hàm là **allocator / deallocator**.
2. **Z3 symbolic reasoning:** kiểm chứng các function summary trên **CFG**, **lọc đường đi bất khả thi** (infeasible paths).
3. **Bước LLM cuối:** **xác nhận bug thật** (giảm false positive) — tương tự ý tưởng *judge/confirm*.

Đây là dạng **static + LLM hybrid** (augment static analysis), **không** dùng dynamic analysis.

## LLM dùng
- **Gemini 3 Flash** — sinh summary.
- **Gemini 3.1 Pro** — validation.

## Dataset & Metrics (đã verify 3-0)
- **Dataset:** 7 dự án C/C++ thực tế — **Vim, tmux, OpenSSL, Redis, FreeRDP, curl, FFmpeg** — tổng **3.4M+ SLOC**.
- **Kết quả:**
  - **52–54 leak duy nhất** phát hiện.
  - So sánh: **CodeQL = 19**, **Infer = 3** (MemHint vượt trội).
  - **49 leak được xác nhận / đã sửa**; **4 CVE**.
- **Metrics dạng P/R/F1:** *không báo công khai dạng leak-only P/R/F1* (báo theo số leak phát hiện + confirmed) → xem câu hỏi mở #2.

## Phạm vi
- **C/C++:** ✅ chuyên biệt.
- **Memory leak:** ✅ **trọng tâm chính**.

## Vai trò làm baseline cho `leak-investigator`
- Trùng khít **lớp Static + LLM** (MCP-wrapped Clang SA / LeakGuard) và **bước LLM-confirm** (~ judge layer).
- **Điểm so sánh số liệu trực tiếp nhất:** chạy leak-investigator trên **cùng các dự án thực** (Vim/tmux/OpenSSL/Redis/curl/FFmpeg) → so **leak-only** (số leak, confirmed, CVE) head-to-head.
- **Khác biệt định vị:** leak-investigator bổ sung **dynamic confirmation** (Valgrind/ASan/LSan) mà MemHint không có → có thể giảm FP còn sót sau Z3.

## ⚠️ Lưu ý
- **Chưa peer-review** (preprint 2026) — tái kiểm venue trước khi trích.
- **KHÔNG dùng** con số *"54 leaks / 8 dự án / 3.6M LOC"* (bị bác bỏ 1-2). Số đúng: **~52–54 leak / 7 dự án / 3.4M+ SLOC**.

## Nguồn
- https://arxiv.org/abs/2603.27224
- https://arxiv.org/html/2603.27224v3
