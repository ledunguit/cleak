# CLeak: Hệ thống LLM điều phối hợp nhất phân tích tĩnh và động phát hiện rò rỉ bộ nhớ C/C++

[![CI](https://github.com/ledunguit/cleak/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/ledunguit/cleak/actions/workflows/ci.yml)
[![Release](https://github.com/ledunguit/cleak/actions/workflows/release.yml/badge.svg)](https://github.com/ledunguit/cleak/actions/workflows/release.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

*Read in English: [README.md](README.md)*

Repository này là hiện vật nghiên cứu (research artifact) đi kèm luận văn Thạc sĩ về
**phát hiện rò rỉ bộ nhớ C/C++ do LLM điều phối**. Nó chứa toàn bộ hệ thống (bộ phân
tích, bộ điều phối, tầng judge), harness đánh giá, các cấu hình baseline, và các gate
tái lập — chính là nơi sinh ra các số liệu được báo cáo trong luận văn, không chỉ là
ví dụ minh hoạ.

> **Bắt đầu tại đây:** tổng quan luận văn ở [docs/THESIS.md](docs/THESIS.md) (một
> trang: bài toán, hệ thống, đóng góp, kết quả chính); chỉ mục tài liệu đầy đủ ở
> [docs/README.md](docs/README.md).

## Tóm tắt

Rò rỉ bộ nhớ (memory leak, CWE-401) trong C/C++ là lớp lỗi không gây crash: chương
trình vẫn chạy nhưng tiêu hao bộ nhớ dần, khó phát hiện bằng test thông thường. Công
cụ static (Clang Static Analyzer, Infer) báo ứng viên mà không thực thi chương trình
nhưng suy luận đường đi/quyền sở hữu con trỏ không đầy đủ nên tỉ lệ false positive cao;
công cụ dynamic (Valgrind Memcheck, AddressSanitizer/LeakSanitizer) cho bằng chứng
chắc chắn nhưng chỉ thấy đường đã thực thi. Cả hai chỉ dừng ở một *cảnh báo* — không
giải thích **vì sao** rò rỉ xảy ra và không đề xuất **cách sửa**.

CLeak để một **LLM điều phối** vòng điều tra thay vì vậy: một vòng lặp agentic 3 pha
(**discovery → investigation → judging/reporting**) chọn thích nghi công cụ static
hay dynamic nào chạy tiếp theo, hợp nhất bằng chứng thành các *leak bundle* theo từng
site, và sinh ra **verdict, giải thích nguyên nhân gốc, và một bản vá khả dụng** — được
đánh giá đầu-cuối so với baseline heuristic thuần và một ablation 9-baseline trên
corpus NIST Juliet CWE-401 đã validate cùng một corpus dự án thật (LAMeD).

## Đóng góp chính

1. **Consensus judge — hợp nhất static/dynamic với self-consistency.** Một judge lấy
   *k* mẫu verdict LLM độc lập rồi hợp nhất (`majority` / `weighted` /
   `unanimous-to-flag`), giảm tỉ lệ lật verdict trên ca biên khoảng 2–4× so với judge
   LLM lấy một mẫu duy nhất.
2. **Giao thức tái lập hai tầng.** Tier-1 (`no_llm`, heuristic tất định + recipe
   dynamic ghim cứng) tất định bit-for-bit qua các lần chạy, được ép bằng gate CI từ
   chối đúng hai kiểu "đậu giả" từng gặp trong quá trình phát triển. Tier-2
   (`llm_assisted`) được báo cáo dưới dạng phân phối (mean ± std qua nhiều lần chạy,
   tỉ lệ lật verdict) thay vì một điểm đơn, vì không thể đạt tất định bit-for-bit với
   judge LLM lấy mẫu.
3. **Tầng bằng chứng dynamic tất định.** Đường dynamic (build + chạy sanitizer) là một
   recipe ghim cứng, không phải quyết định của LLM sub-agent — nên coverage và finding
   dynamic không đổi giữa các lần chạy, cô lập non-determinism do LLM về đúng một chỗ:
   tầng judge.
4. **Làm giàu bằng chứng có cấu trúc cho judge.** Mỗi ứng viên mang theo phân tích
   ownership, cặp alloc→free, và narrative đường rò khả thi, cùng một
   `correlationMethod` phân biệt tương quan static↔dynamic mạnh (khớp file/dòng/hàm)
   với tương quan yếu (chỉ khớp file).

Bài viết đầy đủ kèm kết quả đo được và bàn luận trung thực về giới hạn:
[docs/CONTRIBUTION.md](docs/CONTRIBUTION.md).

## Tổng quan hệ thống

Một đường điều phối duy nhất — CLI/TUI (`apps/leak-inspector-tui`) xây trên lõi
native tool-calling không phụ thuộc framework (`packages/agent-core`) — điều khiển
hai service phân tích qua MCP (Model Context Protocol):

| Giai đoạn | Thành phần | Vai trò |
|---|---|---|
| Discovery + bằng chứng static | `apps/static-analyzer` | Tree-sitter AST, call graph, interprocedural flow, phân tích ownership, Clang `scan-build` |
| Bằng chứng dynamic | `apps/dynamic-analyzer` | Valgrind Memcheck, AddressSanitizer, LeakSanitizer (build + chạy sanitizer) |
| Hợp nhất + phán xử | `packages/common` | Judge heuristic / single-LLM / consensus, ba cấu hình so sánh trực tiếp được |

Một bản hiện thực web trước đây (control-plane NestJS + React SPA) đã bị gỡ khỏi
`master` và được bảo tồn ở nhánh `web-implementation`; `master` nay chỉ còn CLI/TUI.

Chi tiết thành phần/giao thức/pipeline: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
· sequence diagram runtime: [docs/sequence-diagrams.md](docs/sequence-diagrams.md)
· mọi prompt LLM hệ thống dùng: [docs/PROMPTS.md](docs/PROMPTS.md).

## Kết quả

Đo trên corpus NIST Juliet CWE-401 **đã validate** (1.658 ca, content-hash
`f578c3ee…`; quy trình validate đầy đủ: [docs/EVALUATION.md §8](docs/EVALUATION.md)).
Mọi số liệu dưới đây là kết quả chạy thật — lệnh tái lập ở
[docs/BASELINE-COMPARISON.md](docs/BASELINE-COMPARISON.md).

**Hệ thống so với baseline static** — ablation 9-baseline
(`configs/baselines/*.yaml`), mẫu stratified n=50:

| Hệ | Precision | Recall | F1 |
|---|---|---|---|
| **B6a — planner + recipe ghim cứng + LLM judge (cấu hình mạnh nhất)** | **0,973** | 0,906 | **0,938** |
| B1 — static-only (heuristic tất định, không LLM) | 0,792 | 0,792 | 0,792 |
| Clang Static Analyzer (cùng corpus, cùng bộ chấm điểm) | ~0,69 | ~0,84 | ~0,76 |

> **Khả năng tổng quát hoá trên toàn corpus (1.658 ca, static-only) thấp hơn: P 0,680 /
> R 0,556 / F1 0,612.** Mẫu stratified n=50 pha loãng hai family khó chiếm phần lớn
> corpus — C++ `new`/`delete` (1.736 site, recall 16,7%) và `malloc` (precision 36,7%)
> — đây là giới hạn thật ở quy mô lớn, được báo cáo trung thực thay vì lược bỏ. Xem
> phân rã đầy đủ ở [docs/CONTRIBUTION.md](docs/CONTRIBUTION.md).

**Consensus judge giảm dao động verdict** — 30 ca, 2 lần chạy mỗi nhánh, 2 đợt lặp lại
độc lập (A/B):

| Nhánh judge | Tỉ lệ lật verdict | Modal agreement |
|---|---|---|
| Single-LLM (k=1) | 13,3–26,7% | 86,7–93,3% |
| **Consensus (k=3)** | **6,7%** (giống hệt qua cả 2 đợt) | **96,7%** |

**Tất định Tier-1.** Hai lần chạy `no_llm` độc lập (thư mục output tách biệt, cùng
cấu hình) cho điểm số y hệt bit-for-bit (TP29 FP7 FN3 TN38), được ép bằng
`scripts/determinism-gate.sh`.

## Tái lập

- **Chế độ `no_llm` tất định bit-for-bit** và được gate trong CI
  (`scripts/determinism-gate.sh` + `scripts/assert-determinism.ts`), từ chối rõ ràng
  hai kiểu "đậu giả" gặp phải trong quá trình phát triển (tự so với chính mình do
  trùng timestamp, và một lần chạy lỗi toàn bộ giả dạng "tất định").
- **Chế độ `llm_assisted` được báo cáo dưới dạng phân phối**, không phải một điểm đơn:
  `scripts/evaluate-corpus.ts --runs N` (mean ± std) và
  `scripts/verdict-stability.ts` (tỉ lệ lật verdict theo từng ca).
- **Mọi corpus được validate trước khi dùng để đánh giá**: một lockfile
  (`*.lock.json`) ghi content-hash trên toàn bộ file nguồn, được `checkCorpusGate()`
  kiểm tra tại thời điểm chạy — một con số benchmark chỉ đáng tin khi dữ liệu tính ra
  nó đáng tin.

Corpus dùng để đánh giá — **NIST Juliet CWE-401** (tổng hợp, public domain) và
**LAMeD** (EASE 2025, peer-reviewed, 41 leak đã xác nhận trên 7 dự án C thật) — không
commit, được dựng lại theo [docs/DATASETS.md](docs/DATASETS.md); không dùng corpus
tự gán nhãn thủ công làm căn cứ đánh giá.

## Bắt đầu nhanh

**1. Cấu hình CLI/TUI** (đọc `~/.config/cleak/config.json`, không dùng `.env`):

```bash
cd apps/leak-inspector-tui
pnpm install
cleak config init                      # tạo template config đầy đủ
cleak config set provider openai       # hoặc local / anthropic / openai-compat / một profile tuỳ đặt tên
cleak config set endpoints.openai.apiKey sk-...

# Nhiều vendor cùng lúc: tên profile tuỳ ý, không giới hạn ở 4 kiểu dựng sẵn —
# khai báo transport qua `provider`, rồi chuyển active bằng đúng 1 lệnh.
cleak config set endpoints.deepseek-direct.provider openai-compat
cleak config set endpoints.deepseek-direct.baseUrl https://api.deepseek.com/v1
cleak config set endpoints.deepseek-direct.model deepseek-chat
cleak config set endpoints.deepseek-direct.apiKey sk-...
cleak config set provider deepseek-direct   # chuyển active — các profile khác giữ nguyên
```

Thứ tự ưu tiên: **CLI flag > config file > built-in default**. Chi tiết:
[apps/leak-inspector-tui/README.md](apps/leak-inspector-tui/README.md).

**2. Cấu hình và bật các analyzer** (Docker, mỗi service phục vụ MCP/HTTP):

```bash
cp apps/static-analyzer/.env.example  apps/static-analyzer/.env
cp apps/dynamic-analyzer/.env.example apps/dynamic-analyzer/.env
docker compose up --build
```

**3. Chạy một lượt scan:**

```bash
cd apps/leak-inspector-tui
pnpm run dev                           # TUI tương tác
# hoặc headless:
pnpm exec tsx src/cli.ts scan --repo <đường-dẫn-repo-C-hoặc-C++>
```

**4. Tái lập một lượt đánh giá:**

```bash
pnpm run eval:wizard                                   # có hướng dẫn, tự ingest corpus nếu thiếu
pnpm exec tsx evaluation/cli.ts --corpus demo/juliet_cwe401 --baseline B1,B6a,B7 --limit 200 --stratify
```

**Build toàn bộ:**

```bash
pnpm run build
```

## Cấu trúc repository

```
cleak/
├── apps/
│   ├── static-analyzer/           ← phân tích tĩnh, MCP/HTTP (cổng 50061)
│   ├── dynamic-analyzer/          ← phân tích động, MCP/HTTP (cổng 50062)
│   └── leak-inspector-tui/        ← bộ điều phối (CLI/TUI)
├── packages/
│   ├── common/                    ← kiểu dùng chung, Zod schema, judge, render report (@cleak/common)
│   ├── config/                    ← config schema, loader/persister, CLI helper (@cleak/config)
│   ├── agent-core/                ← vòng native tool-calling, MCP client, callModel (@cleak/agent-core)
│   └── observability/             ← structured JSON logging (@cleak/observability)
├── configs/baselines/             ← 9 config YAML ablation năng lực (B1–B7)
├── evaluation/                    ← CLI đánh giá độc lập (wizard hướng dẫn + auto-ingest + sweep baseline)
├── scripts/                       ← script đánh giá/test/tái lập
├── docs/                          ← kiến trúc, prompt, phương pháp đánh giá, bảo mật, dataset
├── paper/                         ← các chương luận văn + danh mục tham khảo
├── demo/                          ← corpus đánh giá (git-ignored; xem docs/DATASETS.md)
├── results/                       ← artifact kết quả chạy (git-ignored)
├── researchs/                     ← ghi chép khảo sát tài liệu
└── docker-compose.yml
```

## Tài liệu

Bắt đầu ở [docs/THESIS.md](docs/THESIS.md); chỉ mục đầy đủ ở [docs/README.md](docs/README.md).

| Tài liệu | Nội dung |
|---|---|
| [docs/THESIS.md](docs/THESIS.md) | Tổng quan luận văn một trang |
| [docs/CONTRIBUTION.md](docs/CONTRIBUTION.md) | Đóng góp, kết quả đo được, bàn luận giới hạn |
| [docs/RELATED-WORK.md](docs/RELATED-WORK.md) | Định vị so với công trình liên quan, so sánh từng paper |
| [docs/EVALUATION.md](docs/EVALUATION.md) | Phương pháp đánh giá, metric, giao thức tái lập |
| [docs/BASELINE-COMPARISON.md](docs/BASELINE-COMPARISON.md) | Runbook so sánh baseline |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Thành phần, giao thức, diagram pipeline |
| [docs/PROMPTS.md](docs/PROMPTS.md) | Mọi prompt LLM hệ thống dùng |
| [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md) | Tham chiếu đầy đủ MCP tool (input schema, handler, ví dụ JSON-RPC) |
| [docs/SECURITY.md](docs/SECURITY.md) | Mô hình tin cậy khi chạy mã không tin cậy |
| [docs/DATASETS.md](docs/DATASETS.md) | Cách lấy/dựng lại corpus đánh giá |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) · [docs/GLOSSARY.md](docs/GLOSSARY.md) · [docs/GOAL.md](docs/GOAL.md) | Runbook, thuật ngữ, tiêu chí thành công |

## Công trình liên quan & Baseline

Chỉ liệt kê công cụ, paper, dataset mà CLeak thực sự tích hợp hoặc so sánh trực tiếp;
định vị chi tiết từng paper ở [docs/RELATED-WORK.md](docs/RELATED-WORK.md) và
[`researchs/`](researchs/); danh mục tham khảo đầy đủ có đánh số ở
[paper/references/bibliography.md](paper/references/bibliography.md).

**Công cụ tích hợp** — Clang Static Analyzer (`scan-build`), Valgrind Memcheck,
AddressSanitizer, LeakSanitizer, Tree-sitter, Model Context Protocol.

**Baseline phát hiện leak so sánh trực tiếp** — **LAMeD** (EASE 2025, CORE-A,
peer-reviewed; baseline leak-only peer-reviewed duy nhất khác; quy ước annotation
AllocSource/FreeSink của nó là cơ sở cho `extraAllocators`/`extraDeallocators` của
CLeak) và **MemHint** (arXiv 2026, neuro-symbolic static + Z3 + LLM-confirm, đánh giá
trên dự án thật).

**Kiến trúc agentic tương đương** — RepoAudit (ICML 2025 poster), FuzzingBrain V2
(arXiv 2026), ATLANTIS (AIxCC 2025, đội thắng), Buttercup (Trail of Bits).

**Nền tảng thiết kế** — ReAct (Yao et al., ICLR 2023) cho vòng tool-calling;
Self-Consistency (Wang et al., ICLR 2023) cho consensus judge.

**Corpus đánh giá** — NIST Juliet CWE-401 (SARD, public domain); LAMeD Zenodo
artifact (cJSON, 152 hàm, DOI: [10.5281/zenodo.15089703](https://doi.org/10.5281/zenodo.15089703)).

## Trích dẫn

```bibtex
@mastersthesis{ledangdung2026cleak,
  title  = {CLeak: LLM-Orchestrated Unified Static and Dynamic Analysis for
            C/C++ Memory Leak Detection},
  author = {Le Dang Dung},
  year   = {2026},
  type   = {Luận văn Thạc sĩ}
}
```

## Giấy phép

Apache License 2.0 — xem [LICENSE](LICENSE).
