# (LOẠI TRỪ) ICSE 2025 LLM4Code — "With a Little Help from My (LLM) Friends"

> ❌ **KHÔNG dùng làm baseline.** Đưa vào để minh bạch — đây là công trình dễ bị nhầm là liên quan nhưng **structurally out of scope**.

## Định danh
- **Tiêu đề:** *With a Little Help from My (LLM) Friends: Enhancing Static Analysis with LLMs to Detect Software Vulnerabilities*
- **Venue / Năm:** **ICSE 2025**, workshop **LLM4Code**
- **Bản full-text:** eScholarship qt0kj3k9h9 · IEEE Xplore doc 11028575

## Vì sao LOẠI TRỪ (đã verify 3-0)
- Nhắm **Java** (ngôn ngữ **garbage-collected**) qua **Semgrep** + **OWASP Benchmark** (2740 test case Java).
- Danh sách CWE **toàn về web/crypto**: CWE-22 (path traversal), CWE-78 (OS command injection), CWE-79 (XSS), CWE-89 (SQLi), CWE-90, CWE-327/328 (weak crypto/hash), CWE-330 (weak randomness)…
- Paper **tự nói:** *"While Java provides memory safety…"*.
- **KHÔNG** có **C/C++**, **KHÔNG** có **memory leak / UAF / double-free / missing-free**.

## Kết luận
- **Cấu trúc nằm ngoài phạm vi** memory-safety của leak-investigator.
- **KHÔNG trích** như baseline memory-safety. Nếu xuất hiện trong literature review, chỉ nên nhắc như "ví dụ LLM+static analysis ở miền khác (Java/web), không áp dụng cho C/C++ memory leak".

## Nguồn
- https://conf.researchr.org/details/icse-2025/llm4code-2025-papers/15/
