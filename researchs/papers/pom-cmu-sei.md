# POM — Pointer Ownership Model (CMU SEI), LLM + SAT

> ⭐⭐ Baseline **phụ trợ**: hướng formal/prevention (LLM + SAT) trên Juliet. Memory leak chỉ tangential.

## Định danh
- **Tiêu đề:** *Design of Enhanced Pointer Ownership Model for C* (POM)
- **Tác giả:** David Svoboda et al. (**CMU Software Engineering Institute**)
- **Venue / Năm:** **SEI Technical Report CMU/SEI-2025-TR-008** (Sep 2025) + blog (Dec 2025). Trang dự án: SEI "AI-Powered Memory Safety for C Applications".
- **Peer-review:** ❌ **Tech report + blog** (một conference paper "sắp nộp", *chưa* được chấp nhận).

## Kỹ thuật
**LLM + Formal methods (prevention/enforcement):**
- **LLM (OpenAI o4-mini)** gán nhãn pointer / dựng **Pointer Ownership Model**.
- **SAT solver** kiểm chứng (sinh model + proof).
- **Mục tiêu:** **enforce temporal memory safety** trong C — cảm hứng từ **Rust borrow checker / C++ RAII**.

→ Khác hướng leak-investigator (prevention vs investigation), nhưng hữu ích cho góc **LLM + SAT/formal verify** + **đánh giá trên Juliet**.

## LLM dùng
- **OpenAI o4-mini**.

## Metrics (đã verify một phần)
- LLM gán nhãn pointer đúng **159 / 169 (94.1%)** — verify **3-0**.
- Eval trên **Juliet C/C++** phủ **CWE-401 (memory leak)**, **CWE-415 (double-free)**, **CWE-416 (UAF)**, cùng **CWE-590**, **CWE-761** — verify **2-1** (nên xác nhận lại từ TR-008).

## Phạm vi
- **C/C++:** ✅ (C).
- **Memory leak:** 🔶 phụ — CWE-401 nằm trong tập Juliet, nhưng POM thiên **prevention** hơn detection.

## Vai trò làm baseline cho `leak-investigator`
- Baseline **phụ** cho lớp **formal/verify (LLM + SAT)** và cho **đánh giá có kiểm soát trên Juliet (CWE-401)**.
- Cung cấp **góc nhìn prevention** (ownership model) tương phản với hướng **investigation đa-bằng-chứng** của leak-investigator.

## ⚠️ Lưu ý
- **Chưa peer-review** (tech report).
- ⛔ **KHÔNG trích** con số **precision 99.84% / recall 83.51%** — **bị bác bỏ 0-3** như metric baseline.

## Nguồn
- https://www.sei.cmu.edu/projects/ai-powered-memory-safety-for-c-applications/
- (Báo cáo gốc: CMU/SEI-2025-TR-008)
