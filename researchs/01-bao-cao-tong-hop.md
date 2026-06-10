# Báo cáo tổng hợp: Baseline LLM cho phát hiện Memory Leak C/C++ (2025–2026)

**Ngày tổng hợp:** 2026-06-09
**Phạm vi:** Công trình 2025–2026 dùng LLM phát hiện memory leak (và UAF / double-free / missing-free) trong C/C++, dùng làm baseline so sánh cho `leak-investigator`.
**Phương pháp:** Deep-research fan-out (5 góc tìm kiếm) → fetch 19 nguồn → trích 91 claim → kiểm chứng đối kháng 3 phiếu/claim (cần ≥2/3 bác bỏ để loại) → 19 claim confirmed, 6 bị loại.

---

## 1. Bối cảnh & tiêu chí chọn baseline

`leak-investigator` là hệ thống **LLM-orchestrated** cho điều tra memory leak trong C/C++ với 4 chiều kiến trúc:

1. **Static + LLM**: MCP server bọc Clang Static Analyzer / LeakGuard.
2. **Dynamic**: Valgrind Memcheck, AddressSanitizer (ASan), LeakSanitizer (LSan).
3. **Orchestration**: control plane trung tâm điều phối các MCP tool.
4. **Judge layer**: sinh verdict, giải thích, đề xuất sửa lỗi.

Một baseline lý tưởng nên khớp **càng nhiều chiều càng tốt** *và* nhắm đúng **memory leak trong C/C++**. Thực tế, **không công trình nào khớp cả 4 chiều** — mỗi baseline phủ một tập con. Bảng dưới ánh xạ baseline ↔ chiều kiến trúc:

| Chiều kiến trúc của leak-investigator | Baseline phủ chiều này |
|---|---|
| Static + LLM (hybrid) | **MemHint**, **LAMeD**, **POM** |
| Dynamic (Valgrind/ASan/LSan) | **FuzzingBrain V2** (một phần: libFuzzer + ASan/MSan/UBSan) |
| Orchestration (agentic/multi-tool) | **RepoAudit**, **FuzzingBrain V2** |
| Judge / validator (giảm FP, verdict) | **RepoAudit** (validator module), MemHint (LLM-confirm step) |
| MCP làm lớp tool | **FuzzingBrain V2** (mọi agent theo MCP protocol) |
| Dataset/benchmark đánh giá | **SecVulEval**, Juliet (POM), DiverseVul (LAMeD) |

---

## 2. Phân tích từng baseline

### 2.1. MemHint — ⭐⭐⭐⭐⭐ Baseline trực tiếp nhất (static + LLM)

> *"Finding Memory Leaks in C/C++ Programs via Neuro-Symbolic Augmented Static Analysis"* — Huang, Shi, B. Wang, Z. Yang, D. Lo (arXiv 2603.27224, 2026).

- **Kỹ thuật:** Neuro-symbolic — LLM hiểu ngữ nghĩa code (phân loại hàm là allocator/deallocator) + **Z3** kiểm chứng symbolic các summary trên CFG, lọc đường đi bất khả thi; một bước LLM cuối **xác nhận bug thật** (giảm FP).
- **LLM:** Gemini 3 Flash (sinh summary) + Gemini 3.1 Pro (validation).
- **Dữ liệu:** 7 dự án C/C++ thực tế (Vim, tmux, OpenSSL, Redis, FreeRDP, curl, FFmpeg), **3.4M+ SLOC**.
- **Kết quả (đã verify):** phát hiện **52–54 leak duy nhất**, so với **19 của CodeQL** và **3 của Infer**; **49 leak được xác nhận/đã sửa**, **4 CVE**.
- **C/C++:** ✅  | **Memory leak là trọng tâm:** ✅
- **Vai trò baseline:** trùng khít **lớp Static + LLM** và **bước LLM-confirm** của leak-investigator; là điểm so sánh số liệu trực tiếp nhất về **leak-only** trên dự án thực.
- ⚠️ **Peer-review:** Tiền ấn phẩm arXiv (2026) — chưa phản biện chính thức.
- ⚠️ **KHÔNG dùng con số "54 leaks / 8 dự án / 3.6M LOC"** (đã bị bác bỏ 1-2). Số đúng: **~52–54 leak / 7 dự án / 3.4M+ SLOC**.

→ Chi tiết: `papers/memhint.md`

---

### 2.2. LAMeD — ⭐⭐⭐⭐⭐ Baseline peer-reviewed mạnh nhất (static + LLM)

> *"LAMeD: LLM-generated Annotations for Memory Leak Detection"* — Shemetova et al., **EASE 2025** (ACM DOI 10.1145/3756681.3756999), arXiv 2505.02376.

- **Kỹ thuật:** LLM tự sinh **annotation theo hàm** — `AllocSource` (cấp phát) / `FreeSink` (giải phóng) — rồi nạp cho **static analyzer cổ điển** (Cooddy `MemoryAndResourceLeakChecker`, CodeQL, Infer). LLM **không fine-tune**, chỉ inference.
- **LLM:** Codestral-22B, Qwen2.5-Coder-32B, DeepSeek-R1-70B; **Codestral** chọn cho eval thực tế.
- **Dữ liệu & metrics (đã verify):**
  - *cJSON benchmark* (152 hàm; 44 AllocSource, 11 FreeSink, 97 unlabeled): Codestral + post-filtering đạt **P = 0.933, R = 0.583** (28 TP, 2 FP, 20 FN) cho **sinh annotation**.
  - *Real-life dataset* (8460 hàm, 7 dự án C: curl, libsolv, libtiff, libxml2, rabbitmq-c, libssh2, cjson — từ **DiverseVul**; 43 leak mục tiêu có tài liệu): với annotation, **CodeQL 5→10** và **Cooddy 5→10** leak mục tiêu được tìm thấy; **đánh đổi** số cảnh báo tăng (CodeQL 139→653, Cooddy 86→391).
- **C/C++:** ✅  | **Memory leak là trọng tâm:** ✅  | **Static-only** (không dynamic/agentic/judge).
- **Vai trò baseline:** analogue cho lớp **MCP-wrapped Clang SA / LeakGuard** của leak-investigator; **baseline đã phản biện đầy đủ** duy nhất cho leak C/C++. Cũng minh hoạ rõ **đánh đổi recall↑ vs FP↑** mà judge layer của leak-investigator có thể giải quyết.
- ✅ **Peer-review:** EASE 2025 (CORE-A).

→ Chi tiết: `papers/lamed.md`

---

### 2.3. RepoAudit — ⭐⭐⭐⭐ Analogue cho Orchestration + Judge

> *"RepoAudit: An Autonomous LLM-Agent for Repository-Level Code Auditing"* — ICML 2025 (poster), arXiv 2501.18160.

- **Kỹ thuật:** **Agentic** — agent memory, khám phá codebase theo nhu cầu (phân tích data-flow fact dọc các đường đi khả thi trong từng hàm), cộng **validator module** kiểm tra data-flow fact + **tính thoả của path condition** để **giảm FP/hallucination**.
- **LLM:** Claude 3.5 Sonnet.
- **Phạm vi defect:** NPD, **ML (memory leak)**, UAF (CWE Top 25).
- **Metrics (đã verify):** **40 bug thật** trên 15 dự án thực; **precision 78.43%** (40 TP / 11 FP = 40/51); trung bình **0.44 giờ** & **$2.54/dự án**; phát hiện **185 bug mới** (174 đã xác nhận/sửa).
- **C/C++:** 🟡 đa ngôn ngữ (KHÔNG "chỉ C/C++").  | **Memory leak:** 🟡 có nhưng không phải trọng tâm.
- **Vai trò baseline:** ánh xạ trực tiếp tới **orchestration + judge/validator** của leak-investigator; validator (kiểm satisfiability path condition) tương tự ý tưởng judge layer.
- ⚠️ **Lưu ý chốt:** precision **78.43% là tổng hợp cả 3 loại bug**, **không phải leak-only**; **không báo recall/FN**.
- ⚠️ **ĐÃ BỊ BÁC BỎ:** RepoAudit **không** bao phủ **double-free**, và **không** nhắm "C/C++ specifically" (đa ngôn ngữ). Đừng trích các khẳng định này.
- 🟡 **Peer-review:** poster ICML 2025 (phản biện nhẹ hơn full paper).

→ Chi tiết: `papers/repoaudit.md`

---

### 2.4. FuzzingBrain V2 — ⭐⭐⭐⭐ Analogue kiến trúc gần nhất (multi-agent + MCP + static+dynamic)

> *"FuzzingBrain V2: A Multi-Agent LLM System for Automated Vulnerability Discovery and Reproduction"* — Ze Sheng, Zhicheng Chen, Qingxiao Xu, Kewen Zhu, Jeff Huang (Texas A&M, arXiv 2605.21779, 2026).

- **Kỹ thuật:** **Multi-agent** với **công cụ static + dynamic dựa trên MCP**; "mọi agent nội bộ theo MCP protocol".
  - **Static:** Fuzz Introspector (call graph / reachability / coverage).
  - **Dynamic:** libFuzzer + **ASan/MSan/UBSan** (vuln được sanitizer xác nhận: *"v là vulnerable iff tồn tại input liên tục gây crash do sanitizer phát hiện tại v"*).
- **LLM:** 3 tầng — Claude Opus 4.5 / Sonnet 4.5 / Haiku 4.5.
- **Dữ liệu & metrics (đã verify):** phần C/C++ của **AIxCC 2025 Final** (40 vuln / 12 dự án), **phát hiện 90% (36/40)**; tìm **41 zero-day** trong 19 dự án OSS.
- **C/C++:** ✅ memory-safety (UAF, double-free, buffer overflow, null deref).  | **Memory leak:** 🔶 chỉ **incidental** (5 trường hợp, Fig 11) — KHÔNG phải trọng tâm.
- **Vai trò baseline:** **gần nhất về mặt kiến trúc** với leak-investigator (static + dynamic + MCP + multi-agent). Dùng để đối chiếu **thiết kế hệ thống** và phương pháp đánh giá-bằng-sanitizer; nhưng **không** là baseline số liệu leak-only.
- ⚠️ **Peer-review:** tiền ấn phẩm arXiv (2026).
- ⚠️ **ĐÃ BỊ BÁC BỎ:** không trích "Argus" (framework multi-agent khác, claim fail 0-3 / 1-2) như baseline.

→ Chi tiết: `papers/fuzzingbrain-v2.md`

---

### 2.5. POM (Pointer Ownership Model, CMU SEI) — ⭐⭐ Baseline phụ trợ (LLM + SAT, prevention)

> *"Design of Enhanced Pointer Ownership Model for C"* — David Svoboda et al., **SEI Technical Report CMU/SEI-2025-TR-008** (Sep 2025) + blog Dec 2025. Trang dự án: SEI "AI-Powered Memory Safety for C Applications".

- **Kỹ thuật:** LLM (**OpenAI o4-mini**) gán nhãn pointer / dựng **ownership model**, **SAT solver** kiểm chứng; **enforce temporal memory safety** (cảm hứng Rust borrow checker / C++ RAII).
- **Metrics (đã verify một phần):** o4-mini gán nhãn đúng **159/169 pointer (94.1%)**. Eval trên **Juliet C/C++** phủ **CWE-401 (memory leak)**, **CWE-415 (double-free)**, **CWE-416 (UAF)**, cùng CWE-590, CWE-761.
- **C/C++:** ✅  | **Memory leak:** 🔶 phụ (CWE-401 nằm trong tập Juliet, nhưng POM thiên về *prevention/enforcement* hơn detection).
- **Vai trò baseline:** baseline phụ cho **lớp formal/verify** (LLM + SAT) và cho **đánh giá trên Juliet**. Bổ sung góc nhìn "phòng ngừa bằng ownership model" khác với hướng "điều tra leak" của leak-investigator.
- ⚠️ **Peer-review:** **SEI tech report + blog**, *chưa* phải conference paper (một bài "sắp nộp").
- ⚠️ **ĐÃ BỊ BÁC BỎ:** **KHÔNG trích con số precision 99.84% / recall 83.51%** (bác bỏ 0-3) như metric baseline.

→ Chi tiết: `papers/pom-cmu-sei.md`

---

### 2.6. SecVulEval — ⭐⭐ Dataset đánh giá (không phải detector)

> *"SecVulEval: Benchmarking LLMs for Real-World C/C++ Vulnerability Detection"* — Ahmed, Harzevili, Shin, Pham, Wang (arXiv 2505.19828, 2025).

- **Bản chất:** **benchmark/dataset**, không phải hệ thống phát hiện.
- **Quy mô (đã verify):** **25,440 mẫu hàm**, **5,867 CVE duy nhất**, **707 dự án C/C++ thực tế** (1999–2024), **145 loại CWE** (gồm CWE-416 UAF, CWE-476 null deref). 10,998 vulnerable + 14,442 non-vulnerable. **Chú thích cấp câu lệnh (statement-level)**, không chỉ binary cấp hàm.
- **C/C++:** ✅  | **Memory leak chuyên biệt:** ❌ (memory-safety chỉ là tập con của 145 CWE).
- **Vai trò baseline:** **dataset đánh giá** cho phần phát hiện vuln C/C++ của leak-investigator (đặc biệt nếu mở rộng ra UAF/null-deref). Có thể trích **tập con CWE liên quan leak** để đánh giá.
- ⚠️ **Peer-review:** preprint arXiv; thực chất là **submission ICLR 2026 đã rút** (OpenReview 0A3qzLmRHd) — chưa được chấp nhận.

→ Chi tiết: `papers/secvuleval.md`

---

### 2.7. (Loại trừ) ICSE 2025 LLM4Code — Java only

> *"With a Little Help from My (LLM) Friends: Enhancing Static Analysis with LLMs to Detect Software Vulnerabilities"* — ICSE 2025 LLM4Code.

- Nhắm **Java** (garbage-collected) qua **Semgrep** + **OWASP Benchmark** (2740 test case); CWE toàn về web/crypto (CWE-22/78/79/89/90/327/328/330…). Paper tự nói *"While Java provides memory safety…"*.
- **KHÔNG** có C/C++, **KHÔNG** memory leak / UAF / double-free / missing-free → **structurally out of scope**.
- **Đưa vào để minh bạch**: **không** dùng làm baseline memory-safety. (Verify 3-0 rằng nó không phù hợp.)

→ Chi tiết: `papers/_excluded-icse2025-java.md`

---

## 3. Khoảng trống nghiên cứu & định vị đóng góp của leak-investigator

1. **Không có baseline static+dynamic chuyên cho LEAK.** FuzzingBrain V2 là hệ duy nhất kết hợp static+dynamic dạng agentic, nhưng **ưu tiên lỗi gây crash** (UAF/double-free/overflow), coi leak là phụ. **MemHint/LAMeD/POM đều static-only.** → `leak-investigator` (Static + **Valgrind/ASan/LSan** + judge) lấp đúng khoảng trống **"điều tra leak đa-bằng-chứng static∧dynamic"**.

2. **Judge layer là điểm khác biệt.** RepoAudit (validator/path-condition SAT) và MemHint (LLM-confirm step) cho thấy xu hướng "lớp xác nhận giảm FP", nhưng **chưa có** hệ nào hợp nhất **bằng chứng static + bằng chứng dynamic** trong một **verdict + đề xuất sửa**. Đây là chỗ định vị đóng góp.

3. **Tập peer-reviewed mỏng.** Nếu hội đồng yêu cầu baseline đã phản biện cho leak C/C++: **LAMeD (EASE 2025)** là lựa chọn chắc chắn; RepoAudit (poster ICML 2025) nếu chấp nhận poster. Phần còn lại nên trình bày là **"recent preprints / industry reports"** kèm caveat.

---

## 4. Khuyến nghị thiết kế thực nghiệm (baseline so sánh)

| Mục tiêu so sánh | Baseline đề xuất | Dataset đề xuất |
|---|---|---|
| Static + LLM cho leak (số liệu leak-only) | **MemHint**, **LAMeD** | Dự án thực của MemHint (Vim/tmux/OpenSSL/Redis/curl/FFmpeg) hoặc real-life set của LAMeD (DiverseVul) |
| Agentic orchestration + judge (precision/FP) | **RepoAudit** | Dự án thực (đối chiếu precision, cost $/giờ) |
| Kiến trúc static+dynamic+MCP (system-level) | **FuzzingBrain V2** | AIxCC 2025 (đối chiếu phương pháp eval-bằng-sanitizer) |
| Formal/LLM+SAT trên benchmark tổng hợp | **POM** | **Juliet** (CWE-401/415/416) |
| Đánh giá vuln C/C++ tổng quát (mở rộng) | — | **SecVulEval** (tập con CWE memory-safety) |

**Lưu ý phương pháp luận chung:**
- Báo cáo metrics **leak-only** (P/R/F1, FP-rate) thay vì gộp nhiều loại bug — vì RepoAudit/POM/FuzzingBrain V2 báo số **tổng hợp**, không leak-only (xem câu hỏi mở #2 trong `04-...`).
- Khi so với static-only (MemHint/LAMeD), nhấn mạnh leak-investigator bổ sung **dynamic confirmation** (Valgrind/ASan/LSan) → giảm FP mà static để lại.
- **Tái kiểm chứng** venue & số liệu của các preprint 2026 (MemHint, FuzzingBrain V2) trước khi nộp.

---

## 5. Câu hỏi mở cần giải quyết trước khi nộp luận văn

1. MemHint (2603.27224) & FuzzingBrain V2 (2605.21779) đã được chấp nhận ở venue top nào (ICSE/FSE/ASE/ISSTA/S&P/USENIX) chưa, hay vẫn là preprint? → quyết định việc có baseline agentic/neuro-symbolic **đã phản biện** hay không.
2. RepoAudit / MemHint / FuzzingBrain V2 báo **recall / FN cho riêng tập memory-leak** là bao nhiêu (không phải tổng hợp)? → để so leak-only P/R/F1.
3. Có baseline 2025–2026 nào **kết hợp cả static lẫn dynamic (Valgrind/ASan/LSan) chuyên cho leak** không? (Hiện **chưa tìm thấy** → research gap của leak-investigator.)
4. Benchmark dùng chung nào để so head-to-head: Juliet/SARD (POM, tổng hợp), DiverseVul (LAMeD), dự án thực của MemHint, hay SecVulEval? (Chưa có cái nào *purpose-built* cho leak.)

*Xem `04-nguon-va-kiem-chung.md` cho danh sách nguồn đầy đủ, các claim bị bác bỏ, và phương pháp kiểm chứng.*
