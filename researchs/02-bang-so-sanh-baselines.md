# Bảng so sánh chi tiết các baseline

So sánh đầy đủ theo các tiêu chí yêu cầu: tiêu đề, tác giả, venue+năm, peer-review, LLM, kỹ thuật, dataset, metrics, C/C++, memory-leak coverage, vai trò baseline.

> Mọi số liệu đã verify 3-0 qua kiểm chứng đối kháng. Các con số **bị bác bỏ** không xuất hiện ở đây (xem `04-nguon-va-kiem-chung.md`).

---

## A. Bảng định danh & trạng thái phản biện

| Công trình | Tác giả (rút gọn) | Venue + Năm | Peer-review | arXiv / DOI |
|---|---|---|---|---|
| **MemHint** | Huang, Shi, B. Wang, Z. Yang, D. Lo | arXiv, 2026 | ❌ Preprint | arXiv 2603.27224 |
| **LAMeD** | Shemetova, Shenbin, Smirnov, Alekseev, Rukhovich, Nikolenko, Lomshakov, Piontkovskaya | **EASE 2025** (CORE-A) | ✅ Có | arXiv 2505.02376 · DOI 10.1145/3756681.3756999 |
| **RepoAudit** | (RepoAudit team) | **ICML 2025** (poster) | 🟡 Poster | arXiv 2501.18160 |
| **FuzzingBrain V2** | Ze Sheng, Zhicheng Chen, Qingxiao Xu, Kewen Zhu, Jeff Huang (Texas A&M) | arXiv, 2026 | ❌ Preprint | arXiv 2605.21779 |
| **POM** | David Svoboda et al. (CMU SEI) | SEI Tech Report CMU/SEI-2025-TR-008, 2025 | ❌ Tech report | SEI project page |
| **SecVulEval** | Ahmed, Harzevili, Shin, Pham, Wang | arXiv, 2025 (ICLR 2026 đã rút) | ❌ Preprint | arXiv 2505.19828 |

---

## B. Bảng kỹ thuật & kiến trúc

| Công trình | LLM | Kỹ thuật chính | Static? | Dynamic? | Agentic / Orchestration? | Judge / Validator? | MCP? |
|---|---|---|---|---|---|---|---|
| **MemHint** | Gemini 3 Flash + Gemini 3.1 Pro | Neuro-symbolic: LLM phân loại alloc/free + Z3 symbolic + LLM-confirm | ✅ | ❌ | ❌ | ✅ (LLM-confirm step) | ❌ |
| **LAMeD** | Codestral-22B / Qwen2.5-Coder-32B / DeepSeek-R1-70B (inference, không fine-tune) | LLM sinh annotation AllocSource/FreeSink → nạp cho SA cổ điển | ✅ (Cooddy/CodeQL/Infer) | ❌ | ❌ | 🟡 (post-filtering annotation) | ❌ |
| **RepoAudit** | Claude 3.5 Sonnet | Autonomous agent + agent memory + data-flow theo path; validator path-condition SAT | 🟡 (dạng data-flow do agent) | ❌ | ✅ | ✅ (validator module) | ❌ |
| **FuzzingBrain V2** | Claude Opus 4.5 / Sonnet 4.5 / Haiku 4.5 | Multi-agent; static (Fuzz Introspector) + dynamic (libFuzzer + ASan/MSan/UBSan) | ✅ | ✅ | ✅ | 🟡 (sanitizer-verified) | ✅ (mọi agent theo MCP) |
| **POM** | OpenAI o4-mini | LLM gán nhãn pointer + dựng ownership model + SAT solver verify (prevention) | ✅ (formal) | ❌ | ❌ | ✅ (SAT proof) | ❌ |
| **SecVulEval** | — (benchmark để đánh giá LLM khác) | Dataset, không phải detector | — | — | — | — | — |

**So với `leak-investigator`** (Static MCP + Dynamic Valgrind/ASan/LSan + control-plane orchestration + judge layer): FuzzingBrain V2 khớp nhiều ô nhất (static+dynamic+agentic+MCP) nhưng **không** chuyên leak; MemHint & LAMeD khớp lớp static+LLM và **đúng** leak; RepoAudit khớp lớp orchestration+judge.

---

## C. Bảng dataset & metrics

| Công trình | Dataset | Metrics chính (đã verify) | Ghi chú |
|---|---|---|---|
| **MemHint** | 7 dự án C/C++ thực: Vim, tmux, OpenSSL, Redis, FreeRDP, curl, FFmpeg (3.4M+ SLOC) | **52–54 leak** (vs CodeQL 19, Infer 3); 49 confirmed/fixed; **4 CVE** | ⚠️ KHÔNG dùng số "54 / 8 dự án / 3.6M LOC" (bác bỏ) |
| **LAMeD** | (1) cJSON (152 hàm); (2) real-life 8460 hàm / 7 dự án C từ **DiverseVul** (43 leak mục tiêu) | Annotation (cJSON, Codestral+filter): **P=0.933, R=0.583** (28 TP/2 FP/20 FN). Real-life: CodeQL **5→10**, Cooddy **5→10** leak; warnings CodeQL 139→653, Cooddy 86→391 | Đánh đổi recall↑ vs FP↑ rất rõ |
| **RepoAudit** | 15 dự án thực (đa ngôn ngữ) | **Precision 78.43%** (40 TP/11 FP=40/51); **40 bug thật**; 0.44 giờ & $2.54/dự án; 185 bug mới (174 fixed) | ⚠️ Precision **tổng hợp** ML+UAF+NPD, **không leak-only**; **không báo recall/FN** |
| **FuzzingBrain V2** | C/C++ của **AIxCC 2025 Final** (40 vuln/12 dự án) | **Phát hiện 90% (36/40)**; **41 zero-day** / 19 dự án OSS | Leak chỉ incidental (5 ca, Fig 11) |
| **POM** | **Juliet** C/C++ (CWE-401/415/416/590/761) | Gán nhãn pointer **159/169 đúng (94.1%)** | ⚠️ KHÔNG dùng "P=99.84% / R=83.51%" (bác bỏ) |
| **SecVulEval** | **Chính nó là dataset**: 25,440 hàm / 5,867 CVE / 707 dự án C/C++ (1999–2024) / 145 CWE | (benchmark) 10,998 vuln + 14,442 non-vuln; chú thích **statement-level** | Không leak-specific |

---

## D. Bảng phạm vi defect & ngôn ngữ

| Công trình | C/C++ chuyên biệt? | Memory leak? | UAF? | Double-free? | Null-deref / NPD? | Buffer overflow? |
|---|---|---|---|---|---|---|
| **MemHint** | ✅ | ✅ (trọng tâm) | — | — | — | — |
| **LAMeD** | ✅ | ✅ (trọng tâm) | — | — | — | — |
| **RepoAudit** | 🟡 đa ngôn ngữ | ✅ | ✅ | ❌ (bác bỏ) | ✅ | — |
| **FuzzingBrain V2** | ✅ | 🔶 incidental | ✅ | ✅ | ✅ | ✅ |
| **POM** | ✅ | 🔶 CWE-401 (phụ) | ✅ (CWE-416) | ✅ (CWE-415) | — | — |
| **SecVulEval** | ✅ (benchmark) | 🔶 tập con CWE | ✅ (CWE-416) | — | ✅ (CWE-476) | (đa CWE) |

Chú thích: ✅ có/trọng tâm · 🟡 một phần/đa ngôn ngữ · 🔶 phụ/incidental · ❌ không · — không nêu rõ.

---

## E. Bảng "vai trò baseline cho leak-investigator"

| Công trình | Chiều khớp nhất | Cách dùng làm baseline | Hạn chế khi so sánh |
|---|---|---|---|
| **MemHint** | Static + LLM (leak C/C++) | So **leak-only** trên dự án thực; đối chiếu bước LLM-confirm | Static-only; chưa peer-review; số liệu cần tái kiểm |
| **LAMeD** | Static + LLM (annotation) | Baseline **đã phản biện**; minh hoạ recall↑/FP↑ mà judge layer giải quyết | Static-only; không dynamic/agentic |
| **RepoAudit** | Orchestration + judge/validator | So precision & cost; đối chiếu validator vs judge layer | Precision tổng hợp (không leak-only); đa ngôn ngữ |
| **FuzzingBrain V2** | Static+Dynamic+MCP+multi-agent | So **kiến trúc hệ thống** & eval-bằng-sanitizer | Leak chỉ phụ; chưa peer-review |
| **POM** | LLM + SAT (formal, Juliet) | Baseline phụ trên **Juliet**; góc prevention | Thiên prevention; tech report; leak phụ |
| **SecVulEval** | Dataset đánh giá | Tập con CWE memory-safety để eval | Không leak-specific; preprint đã rút |

> Tóm tắt: **MemHint + LAMeD** = baseline số liệu leak C/C++. **RepoAudit + FuzzingBrain V2** = analogue kiến trúc (orchestration/judge & static+dynamic+MCP). **POM + SecVulEval** = phụ trợ (formal baseline + dataset).
