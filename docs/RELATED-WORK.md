# Baseline & Related Work

> Distill từ thư mục [`../researchs/`](../researchs/) (khảo sát deep-research 2025–2026,
> đã kiểm chứng đối kháng 3 phiếu/claim). Tài liệu này tóm tắt **để trích dẫn trong luận
> văn**; chi tiết từng paper ở `researchs/papers/*`, log kiểm chứng + **claim bị bác bỏ**
> ở [`../researchs/04-nguon-va-kiem-chung.md`](../researchs/04-nguon-va-kiem-chung.md).
>
> ⚠️ **Caveat độ tin cậy:** vài công trình là **preprint arXiv 2026 rất mới** — phải kiểm
> lại venue/peer-review và số liệu từ PDF gốc trước khi đưa vào bản nộp.

---

## 1. Ba trục so sánh

`leak-investigator` = **static (MCP/Clang) + dynamic (Valgrind/ASan/LSan) + điều phối
agentic + judge layer**, chuyên **memory leak C/C++**. Không một baseline nào khớp cả ba,
nên ta chọn theo ba trục bù nhau:

- **Trục A — Defect + ngôn ngữ (leak C/C++ trực tiếp):** MemHint, LAMeD.
- **Trục B — Kiến trúc (agentic + judge + static/dynamic + MCP):** FuzzingBrain V2, RepoAudit,
  ATLANTIS, Buttercup.
- **Trục C — Formal / dataset (phụ trợ):** POM, SecVulEval.

## 2. Bảng xếp hạng nhanh

| # | Công trình | Năm | Peer-review | Trục khớp | Leak là trọng tâm? | Mức phù hợp |
|---|---|---|---|---|---|---|
| 1 | **MemHint** | 2026 | ❌ arXiv | A (static+LLM neuro-symbolic) | ✅ | ⭐⭐⭐⭐⭐ trực tiếp nhất |
| 2 | **LAMeD** | 2025 | ✅ EASE 2025 (CORE-A) | A (static+LLM annotation) | ✅ | ⭐⭐⭐⭐⭐ peer-reviewed mạnh nhất |
| 3 | **RepoAudit** | 2025 | 🟡 ICML poster | B (agentic + validator) | 🟡 (ML/UAF/NPD) | ⭐⭐⭐⭐ |
| 4 | **FuzzingBrain V2** | 2026 | ❌ arXiv | B (multi-agent+MCP+static+dynamic) | 🔶 phụ (crash) | ⭐⭐⭐⭐ analogue gần nhất |
| 5 | **POM (CMU SEI)** | 2025 | ❌ Tech report | C (LLM+SAT, prevention) | 🔶 CWE-401 phụ | ⭐⭐ |
| 6 | **SecVulEval** | 2025 | ❌ arXiv (rút ICLR'26) | C (dataset) | ❌ vuln tổng quát | ⭐⭐ |

> ❌ **Loại trừ:** ICSE 2025 LLM4Code *"With a Little Help from My (LLM) Friends"* — chỉ
> **Java** (GC) + OWASP Benchmark, không C/C++, không leak. Đưa vào để minh bạch, không
> dùng làm baseline (`researchs/papers/_excluded-icse2025-java.md`).

## 3. Phiếu từng hệ (Trục A — leak C/C++ trực tiếp)

### MemHint — neuro-symbolic LLM + Z3 (`researchs/papers/memhint.md`)
- **Kỹ thuật:** LLM (Gemini 3 Flash/3.1 Pro) phân loại allocator/deallocator → xác minh
  symbolic bằng **Z3** trên CFG → LLM-confirm verdict (giảm FP). **Static-only.**
- **Dữ liệu/Số liệu:** 7 dự án C/C++ thực (Vim, tmux, OpenSSL, Redis, FreeRDP, curl, FFmpeg;
  3.4M+ SLOC) → **52–54 leak** (vs CodeQL 19, Infer 3); 49 confirmed/fixed; **4 CVE**.
  (⚠️ KHÔNG dùng "54 / 8 dự án / 3.6M LOC" — bị bác bỏ.)
- **Vai trò baseline:** so **leak-only** trên dự án thực; đối chiếu bước LLM-confirm với judge
  layer. **Hạn chế:** static-only, chưa peer-review.

### LAMeD — LLM sinh annotation (`researchs/papers/lamed.md`)
- **Kỹ thuật:** LLM (Codestral-22B / Qwen2.5-Coder-32B / DeepSeek-R1-70B, inference) sinh
  annotation **AllocSource/FreeSink** → nạp cho analyzer cổ điển (Cooddy/CodeQL/Infer).
  **Static-only.** ✅ **EASE 2025** (CORE-A) — baseline peer-reviewed duy nhất cho leak C/C++.
- **Số liệu:** cJSON (152 hàm, Codestral+filter) **P=0.933, R=0.583** (28 TP/2 FP/20 FN);
  real-life (43 leak): CodeQL **5→10**, Cooddy **5→10**, nhưng warnings CodeQL **139→653**,
  Cooddy **86→391**.
- **Vai trò baseline:** minh hoạ rõ **đánh đổi recall↑ / FP↑** — chính là vấn đề **consensus
  judge** (hợp nhất static+dynamic) nhắm giải quyết. **Reproducibility:** artifact Zenodo
  (BSD-3), nhưng Cooddy không pin version → không bit-exact (xem `papers/lamed-reproducibility.md`).

## 4. Phiếu từng hệ (Trục B — analogue kiến trúc)

### FuzzingBrain V2 (`researchs/papers/fuzzingbrain-v2.md`)
- **Kiến trúc gần nhất:** multi-agent **trên MCP**; static (Fuzz Introspector) + dynamic
  (libFuzzer + ASan/MSan/UBSan). Claude Opus/Sonnet/Haiku.
- **Số liệu:** AIxCC 2025 Final (40 vuln/12 dự án) → **90% (36/40)**; 41 zero-day/19 OSS.
- **Khác biệt then chốt:** xác minh bằng **crash sanitizer** ("vuln tồn tại ⟺ input tái hiện
  crash"). Leak chỉ **incidental** (5 ca). → `leak-investigator` mở rộng sang **non-crash leak**
  (bằng chứng LSan/Valgrind, không cần crash).

### RepoAudit (`researchs/papers/repoaudit.md`)
- **Agentic + validator:** agent tự khám phá repo + **validator** kiểm path-condition SAT để
  giảm FP (tương tự judge layer). Claude 3.5 Sonnet.
- **Số liệu:** 15 dự án (đa ngôn ngữ) → **Precision 78.43%** (40 TP/11 FP); 0.44h & **$2.54/dự án**;
  185 bug mới. ⚠️ Precision **tổng hợp** ML+UAF+NPD (không leak-only); **không báo recall/FN**.
- **Vai trò:** so kiến trúc orchestration+judge & chi phí.

### ATLANTIS & Buttercup (cụm AIxCC 2025 — `researchs/05-baseline-kien-truc.md`)
- **ATLANTIS** (Team Atlanta, vô địch AIxCC 2025): static+dynamic+agentic+judge, C/C++; tech
  report arXiv 2509.14589; closed-source; MCP chưa xác nhận.
- **Buttercup** (Trail of Bits, hạng 2): dynamic+multi-agent+MCP+judge; **open-source AGPL-3.0**,
  chạy được trên laptop; tầng static ít tài liệu.
- **Vai trò:** bức tranh hệ agentic static+dynamic; đều xác minh **bằng crash** → tương phản
  với lớp non-crash leak. (RoboDuck — "LLM-first, no fuzzing" — dùng làm ví dụ tương phản.)

## 5. Phiếu từng hệ (Trục C — phụ trợ)

- **POM (CMU SEI)** (`researchs/papers/pom-cmu-sei.md`): LLM (o4-mini) gán nhãn pointer →
  **SAT** verify ownership model (hướng **prevention**, kiểu Rust borrow-checker). Gán nhãn
  **159/169 đúng (94.1%)** trên Juliet (CWE-401/415/416/590/761). ⚠️ KHÔNG dùng "P=99.84%/R=83.51%"
  (bác bỏ). Tech report, không peer-review; leak là phụ.
- **SecVulEval** (`researchs/papers/secvuleval.md`): **dataset**, không phải detector —
  25,440 hàm / 5,867 CVE / 707 dự án C/C++ / 145 CWE, chú thích **statement-level**. Dùng làm
  tập đánh giá phụ (lọc tập con CWE memory-safety). Preprint đã rút khỏi ICLR 2026.

## 6. Bảng kỹ thuật & vai trò (tóm tắt)

| Công trình | Static | Dynamic | Agentic | Judge/Validator | MCP | Số liệu chính | Vai trò baseline |
|---|:--:|:--:|:--:|:--:|:--:|---|---|
| MemHint | ✅ | ❌ | ❌ | ✅ (LLM-confirm) | ❌ | 52–54 leak | số liệu leak C/C++ |
| LAMeD | ✅ | ❌ | ❌ | 🟡 (filter) | ❌ | P0.933/R0.583 (cJSON) | peer-reviewed, recall↑/FP↑ |
| RepoAudit | 🟡 | ❌ | ✅ | ✅ (SAT) | ❌ | P0.784 (đa defect) | orchestration+judge |
| FuzzingBrain V2 | ✅ | ✅ | ✅ | 🟡 (sanitizer) | ✅ | 90% (crash) | analogue kiến trúc |
| POM | ✅(formal) | ❌ | ❌ | ✅ (SAT) | ❌ | 94.1% gán nhãn | formal/prevention |
| SecVulEval | — | — | — | — | — | 25.4K hàm | dataset đánh giá |

## 7. Research gap & định vị

1. **Baseline leak C/C++ trực tiếp** đều **static-only** (MemHint, LAMeD) → `leak-investigator`
   bổ sung tầng **dynamic** (Valgrind/ASan/LSan) + **judge** hợp nhất.
2. **Analogue kiến trúc** (FuzzingBrain V2, RepoAudit, ATLANTIS, Buttercup) đều xác minh **bằng
   crash** → `leak-investigator` chuyển mô hình sang lớp **non-crash leak**.
3. **Khoảng trống:** *chưa tìm thấy* hệ 2025–2026 nào kết hợp **static + dynamic chuyên cho
   memory-LEAK** trong C/C++ — vị trí định vị mạnh của luận văn.
4. **Baseline peer-reviewed rất mỏng:** chỉ **LAMeD** (EASE 2025) đầy đủ phản biện; RepoAudit
   là poster; còn lại preprint/tech-report → cân nhắc khi luận văn yêu cầu baseline đã phản biện.

> Cách **chạy** so sánh thực nghiệm với baseline cài-được (clang-analyzer/infer) trên cùng
> corpus + cùng scorer: [BASELINE-COMPARISON.md](BASELINE-COMPARISON.md).
