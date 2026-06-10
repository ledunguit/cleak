# LAMeD — LLM-generated Annotations for Memory Leak Detection

> ⭐⭐⭐⭐⭐ **Baseline peer-reviewed mạnh nhất** cho memory leak C/C++ (duy nhất đã phản biện đầy đủ).

## Định danh
- **Tiêu đề:** *LAMeD: LLM-generated Annotations for Memory Leak Detection*
- **Tác giả:** Shemetova, Shenbin, Smirnov, Alekseev, Rukhovich, Nikolenko, Lomshakov, Piontkovskaya
- **Venue / Năm:** **EASE 2025** — 29th Intl Conf on Evaluation and Assessment in Software Engineering (**CORE-A**)
- **Peer-review:** ✅ **Có** (ACM DL)
- **DOI:** 10.1145/3756681.3756999 · **arXiv:** 2505.02376

## Kỹ thuật
**Static + LLM hybrid:** LLM tự sinh **annotation theo hàm**:
- `AllocSource` — hàm cấp phát bộ nhớ.
- `FreeSink` — hàm giải phóng bộ nhớ.

Các annotation này được **nạp vào static analyzer cổ điển** để phát hiện leak:
- **Cooddy** `MemoryAndResourceLeakChecker` (chính),
- **CodeQL**, **Infer**.

LLM **chỉ inference, KHÔNG fine-tune**. Có bước **post-filtering** annotation.

## LLM dùng
- **Codestral-22B** (chọn cho eval thực tế), **Qwen2.5-Coder-32B**, **DeepSeek-R1-70B**.

## Dataset & Metrics (đã verify 3-0)
**(1) cJSON benchmark** — 152 hàm (44 AllocSource, 11 FreeSink, 97 unlabeled):
- Codestral + post-filtering cho **sinh annotation**: **P = 0.933, R = 0.583** (28 TP, 2 FP, 20 FN).

**(2) Real-life dataset** — 8460 hàm, 7 dự án C (**curl, libsolv, libtiff, libxml2, rabbitmq-c, libssh2, cjson**; trích từ **DiverseVul**), **43 leak mục tiêu có tài liệu**:
- Với annotation của LAMeD: **CodeQL 5 → 10** và **Cooddy 5 → 10** leak mục tiêu được tìm thấy (**gấp đôi**).
- **Đánh đổi:** số cảnh báo tăng mạnh — CodeQL **139 → 653**, Cooddy **86 → 391**.

## Phạm vi
- **C/C++:** ✅ chuyên biệt.
- **Memory leak:** ✅ **trọng tâm chính**.
- **Static-only:** ❌ không dynamic / agentic / judge.

## Vai trò làm baseline cho `leak-investigator`
- Analogue trực tiếp cho **lớp MCP-wrapped Clang SA / LeakGuard**.
- **Baseline đã phản biện đầy đủ duy nhất** cho leak C/C++ → **lựa chọn an toàn nhất** nếu hội đồng yêu cầu peer-reviewed baseline.
- **Minh hoạ rõ đánh đổi recall↑ vs FP↑** (10 leak nhưng 653 cảnh báo) → đúng vấn đề mà **judge layer + dynamic confirmation** của leak-investigator nhắm giải quyết. Có thể định vị đóng góp: "giữ recall như LAMeD nhưng cắt FP bằng dynamic + judge".
- So trực tiếp trên **cùng real-life set (DiverseVul, 43 leak)**.

## Khả năng reproduce
✅ **Reproducible-in-principle (assembly-required).** Có artifact chính thức mở trên **Zenodo** (BSD-3-Clause): code `lamed_run.py` + **prompt LLM thật** (`lamed.yaml`) + cả 2 benchmark (`cJSON-annotated.csv`, `memleak_benchmark.json`). Cả 3 LLM open-weight; Cooddy open-source có docs annotation. **Nút thắt:** Cooddy không pin version trong artifact, thiếu cấu hình inference, không badge AE, chưa ai repro độc lập → không khớp bit-exact. **Chi tiết đầy đủ + kế hoạch repro:** [`lamed-reproducibility.md`](./lamed-reproducibility.md).

## Nguồn
- https://arxiv.org/abs/2505.02376
- https://dl.acm.org/doi/full/10.1145/3756681.3756999
