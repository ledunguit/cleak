# Benchmark & Dataset cho đánh giá Memory Leak / Vuln C/C++

Tổng hợp các benchmark/dataset xuất hiện trong các công trình baseline, kèm đánh giá mức độ phù hợp để **đánh giá leak-investigator**. Điểm mấu chốt: **chưa có benchmark nào được thiết kế riêng (purpose-built) cho đánh giá memory-LEAK trong C/C++** — đây là một câu hỏi mở (xem `04-...` #4).

---

## 1. SecVulEval — benchmark CVE C/C++ thực tế, cấp câu lệnh

- **Nguồn:** arXiv 2505.19828 — *"SecVulEval: Benchmarking LLMs for Real-World C/C++ Vulnerability Detection"* (Ahmed, Harzevili, Shin, Pham, Wang, 2025).
- **Quy mô:** **25,440 mẫu hàm**; **5,867 CVE** duy nhất; **707 dự án C/C++** thực tế (1999–2024); **145 loại CWE**. 10,998 vulnerable + 14,442 non-vulnerable.
- **Đặc trưng:** chú thích **statement-level** (không chỉ binary cấp hàm) → phù hợp đánh giá định vị chính xác.
- **CWE liên quan memory-safety:** CWE-416 (UAF), CWE-476 (null deref), … (memory-safety là **tập con** của 145 CWE).
- **Phù hợp leak-investigator:** ✅ dùng để đánh giá phần phát hiện vuln C/C++ (đặc biệt nếu mở rộng sang UAF/null-deref). Có thể **lọc tập con CWE liên quan leak**.
- ⚠️ **Caveat:** preprint, **submission ICLR 2026 đã bị rút** (OpenReview 0A3qzLmRHd) — chưa peer-reviewed; **không leak-specific**.

---

## 2. Juliet (NIST SARD) — bộ test tổng hợp

- **Dùng bởi:** **POM** (CMU SEI).
- **CWE phủ (trong eval POM):** **CWE-401 (memory leak)**, CWE-415 (double-free), CWE-416 (UAF), CWE-590, CWE-761.
- **Bản chất:** test case **tổng hợp** (synthetic), có ground-truth rõ ràng → tốt cho đo precision/recall có kiểm soát.
- **Phù hợp leak-investigator:** ✅ baseline tổng hợp tiêu chuẩn cho **CWE-401**; dễ tái lập, nhưng **synthetic** nên không phản ánh độ phức tạp dự án thực.

---

## 3. DiverseVul — nguồn dữ liệu dự án thực

- **Dùng bởi:** **LAMeD** (rút "real-life dataset" 8460 hàm / 7 dự án C: curl, libsolv, libtiff, libxml2, rabbitmq-c, libssh2, cjson; 43 leak mục tiêu có tài liệu).
- **Bản chất:** dataset vuln C/C++ thực tế (function-level).
- **Phù hợp leak-investigator:** ✅ nguồn dự án thực có **leak mục tiêu được tài liệu hoá** → so sánh trực tiếp với LAMeD trên cùng tập.

---

## 4. cJSON benchmark (do LAMeD chú thích thủ công)

- **Nguồn:** LAMeD.
- **Quy mô:** 152 hàm — 44 AllocSource, 11 FreeSink, 97 unlabeled.
- **Dùng để:** đánh giá **chất lượng sinh annotation** alloc/free (LAMeD báo Codestral+filter P=0.933, R=0.583).
- **Phù hợp leak-investigator:** 🟡 hữu ích nếu leak-investigator cũng sinh nhãn alloc/free; nhỏ, hẹp.

---

## 5. AIxCC 2025 Final (phần C/C++)

- **Dùng bởi:** **FuzzingBrain V2**.
- **Quy mô:** 40 vuln / 12 dự án C/C++.
- **Bản chất:** benchmark thi đấu (AI Cyber Challenge), vuln gây crash xác nhận bằng sanitizer.
- **Phù hợp leak-investigator:** 🔶 thiên về lỗi gây crash (UAF/double-free/overflow), **leak không phải trọng tâm**; tốt để đối chiếu **phương pháp eval-bằng-sanitizer** (tương tự ASan/LSan của leak-investigator).

---

## 6. Dự án thực do MemHint dùng

- Vim, tmux, OpenSSL, Redis, FreeRDP, curl, FFmpeg (**3.4M+ SLOC**).
- **Phù hợp leak-investigator:** ✅ tập **dự án thực, leak thật** (49 confirmed/fixed, 4 CVE) → so head-to-head leak-only với MemHint trên cùng codebase rất thuyết phục.

---

## Bảng tổng kết & khuyến nghị

| Benchmark/Dataset | Loại | Leak-specific? | Ground-truth | Khuyến nghị cho leak-investigator |
|---|---|---|---|---|
| **SecVulEval** | Dự án thực, CVE | ❌ (tập con) | Statement-level | Đánh giá vuln C/C++ tổng quát; lọc CWE memory-safety |
| **Juliet (SARD)** | Tổng hợp | 🔶 CWE-401 | Đầy đủ | Baseline tiêu chuẩn có kiểm soát cho leak |
| **DiverseVul** | Dự án thực | 🟡 (leak mục tiêu) | Function-level | So trực tiếp với LAMeD |
| **cJSON (LAMeD)** | Tổng hợp nhỏ | ✅ alloc/free | Thủ công | Đánh giá sinh nhãn alloc/free |
| **AIxCC 2025** | Thi đấu | ❌ | Sanitizer | Đối chiếu eval-bằng-sanitizer |
| **MemHint real projects** | Dự án thực | ✅ | Confirmed/CVE | So leak-only head-to-head với MemHint |

> **Khuyến nghị chốt:** dùng **kết hợp** — (a) **Juliet CWE-401** cho đánh giá có kiểm soát; (b) **dự án thực của MemHint hoặc DiverseVul** cho đánh giá thực tế leak-only; (c) **SecVulEval** nếu mở rộng phạm vi sang UAF/null-deref. Cần **tự xây/đối chiếu ground-truth leak** vì chưa có benchmark purpose-built cho leak.
