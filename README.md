# Thesis Workspace

Workspace gốc cho luận văn Thạc sĩ về điều tra rò rỉ bộ nhớ C/C++ do LLM điều phối.
Đây là workspace ô (umbrella), không phải một repo triển khai đơn lẻ, nó gom các thành
phần của luận văn ở cùng một cấp. `master` là TUI-only (bản web cũ đã tách nhánh).

> Tài liệu luận văn: bắt đầu ở [docs/THESIS.md](docs/THESIS.md) (đọc trước),
> chỉ mục đầy đủ ở [docs/README.md](docs/README.md).

## Định vị

`leak-investigator` kết hợp tĩnh (MCP/Clang), động (Valgrind/ASan/LSan), điều phối agentic
và judge layer, chuyên memory leak C/C++. Theo khảo sát 2025-2026 (xem `researchs/`),
không có hệ nào kết hợp cả tĩnh lẫn động chuyên cho leak trong C/C++. Chi tiết baseline
và định vị: [xem mục Tham khảo](#tham-khảo--baseline).

## Thành phần

### `apps/leak-inspector-tui`, Scanner độc lập (Ink CLI/TUI), ORCHESTRATOR
- Scanner agentic headless/tương tác, là điểm điều phối. Native tool-calling qua
  `packages/agent-core`.
- Workflow HYBRID 4 pha: (A) sub-agent tĩnh fan-out thu bằng chứng; (B) worker động
  build + chạy sanitizer, hoặc theo recipe tất định (`buildTarget → lsanRun`, không LLM);
  (C) tổng hợp; (D) hybrid judge (heuristic cho mọi bundle + LLM judge cho borderline +
  consensus tuỳ chọn trên k mẫu).
- Kết nối analyzer qua MCP; ghi artifact (JSON/Markdown/HTML/snapshot) vào `results/<scanId>/`.
- Xem thêm: [apps/leak-inspector-tui/README.md](apps/leak-inspector-tui/README.md)

### `apps/static-analyzer`, Phân tích tĩnh (NestJS)
- Phục vụ MCP Streamable-HTTP (cổng 50061) cho TUI.
- Tree-sitter AST (C + C++), lexical scan, call graph, ownership, ràng buộc đường đi heuristic (không SMT solver),
  Clang Static Analyzer (`scan-build`) tự chứa (submodule LeakGuard đã gỡ).
- Xem thêm: [apps/static-analyzer/README.md](apps/static-analyzer/README.md)

### `apps/dynamic-analyzer`, Phân tích động (NestJS)
- Phục vụ MCP Streamable-HTTP (cổng 50062) cho TUI.
- Valgrind Memcheck, AddressSanitizer, LeakSanitizer (chỉ Linux/Docker).
- Xem thêm: [apps/dynamic-analyzer/README.md](apps/dynamic-analyzer/README.md)

### `packages/agent-core`, Lõi agentic (thư viện TS)
- Vòng lặp native tool-calling không phụ thuộc framework, MCP client, `callModel` đa provider
  (streaming, idle-timeout, nén ngữ cảnh).
- Xem thêm: [packages/agent-core/README.md](packages/agent-core/README.md)

### `packages/common` (`@cleak/common`), Kiểu & judge dùng chung
- TypeScript types + Zod schema; heuristic judge + consensus judge + phân tích leak + độ đo
  đánh giá + render report. Dùng chung qua `@cleak/common`.
- Xem thêm: [packages/common/README.md](packages/common/README.md)

### `packages/config` (`@cleak/config`), Quản lý cấu hình tập trung
- Zod schema, JSON loader/persister tại `~/.config/cleak/config.json`,
  CLI helpers (`config init/get/set/unset`), chuyển đổi provider settings.

> TUI/CLI đọc config từ `~/.config/cleak/config.json`, KHÔNG dùng .env.
> Các Docker analyzer dùng .env riêng (`.env.example` trong mỗi thư mục app).

> MCP/HTTP là transport duy nhất. Server gRPC + thư mục `proto/` đã được gỡ khỏi
> `master` (không còn consumer sau khi bỏ control-plane web). Tool I/O khai báo bằng
> Zod `inputSchema` ngay trong MCP server của từng analyzer.

### Cây thư mục

```
cleak/
├── apps/
│   ├── static-analyzer/           ← Phân tích tĩnh MCP (cổng 50061)
│   ├── dynamic-analyzer/          ← Phân tích động MCP (cổng 50062)
│   └── leak-inspector-tui/        ← ORCHESTRATOR (CLI/TUI)
├── packages/
│   ├── common/                    ← Kiểu, Zod, judge, render (@cleak/common)
│   ├── config/                    ← Zod schema, loader/persister CLI (@cleak/config)
│   └── agent-core/                ← Native tool-calling loop, MCP client, callModel
├── configs/
│   └── baselines/                 ← 9 YAML baseline (b1–b7)
├── scripts/                       ← Eval/test scripts
├── docs/                          ← Tài liệu
├── paper/references/              ← Bibliography
├── demo/memory_leak_corpus/       ← Corpus kiểm thử
├── results/                       ← Artifact (git-ignored)
├── researchs/                     ← Ghi chép khảo sát
├── docker-compose.yml
├── package.json
├── turbo.json
└── tsconfig.base.json
```

> Xem [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md) cho chi tiết từng MCP tool (input schema,
> return type, JSON-RPC example). Xem [CLAUDE.md](CLAUDE.md) cho project overview
> dành cho AI assistant.

## Luồng hệ thống

Một đường điều phối: TUI (`leak-inspector-tui`) chạy vòng native tool-calling của
`agent-core`, gọi thẳng analyzer qua MCP và ghi artifact ra đĩa.

1. Analyzer tĩnh/động expose MCP tool
2. TUI điều phối điều tra trên một repo C/C++ mục tiêu
3. Findings được chuẩn hoá thành leak bundle dùng chung
4. Hệ trả verdict + giải thích + gợi ý sửa, render 4 định dạng report

Xem [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) cho thành phần, giao thức, diagram.

> Đường điều phối web cũ (`control-plane` + React SPA `leak-inspector-ui`) đã được gỡ khỏi
> `master`, bảo tồn ở nhánh `web-implementation`.

## Corpus demo

- `demo/memory_leak_corpus/` gồm các ca kiểm thử cho đánh giá (`simple_leak`, `early_return_leak`,
  `ownership_maze`, ...), mỗi ca biên dịch bằng `make CC=clang`.
- Nguồn corpus (Juliet, LAMeD) không commit, xem [docs/DATASETS.md](docs/DATASETS.md).

## Bắt đầu nhanh

### 1. Cấu hình TUI/CLI (config.json)

Bộ điều phối (`leak-inspector-tui`) đọc config từ `~/.config/cleak/config.json`:

```bash
cd apps/leak-inspector-tui
bun install
cleak config init            # tạo template đầy đủ
cleak config set LLM_API_KEY sk-...   # thêm key LLM (nếu cần)
```

Thứ tự ưu tiên: **CLI flag > config file > built-in default**.
Xem thêm: [apps/leak-inspector-tui/README.md](apps/leak-inspector-tui/README.md).

### 2. Cấu hình Docker analyzer (.env)

Các analyzer dùng Docker đọc `.env` riêng:

```bash
cp apps/static-analyzer/.env.example  apps/static-analyzer/.env
cp apps/dynamic-analyzer/.env.example apps/dynamic-analyzer/.env
```

### 3. Bật analyzer (static + dynamic, MCP)

```bash
docker compose up --build
```

### 4. Chạy TUI scanner

```bash
cd apps/leak-inspector-tui
bun run dev
```

### Build toàn bộ (Turbo)

```bash
bun run build
```

## Tài liệu

Bắt đầu ở [docs/THESIS.md](docs/THESIS.md); chỉ mục đầy đủ ở [docs/README.md](docs/README.md).

- [docs/THESIS.md](docs/THESIS.md) tổng quan luận văn (đọc trước)
- [docs/CONTRIBUTION.md](docs/CONTRIBUTION.md) đóng góp học thuật + kết quả
- [docs/RELATED-WORK.md](docs/RELATED-WORK.md) baseline & related work (chi tiết từng paper)
- [docs/EVALUATION.md](docs/EVALUATION.md) phương pháp đánh giá + tái lập
- [docs/BASELINE-COMPARISON.md](docs/BASELINE-COMPARISON.md) runbook chạy so sánh baseline
- [docs/OPERATIONS.md](docs/OPERATIONS.md) chạy/tái lập end-to-end
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) thành phần, giao thức, diagram
- [docs/PROMPTS.md](docs/PROMPTS.md) danh mục mọi prompt LLM + mô tả tool
- [docs/sequence-diagrams.md](docs/sequence-diagrams.md) luồng tuần tự runtime
- [docs/GLOSSARY.md](docs/GLOSSARY.md) · [docs/DATASETS.md](docs/DATASETS.md) · [docs/SECURITY.md](docs/SECURITY.md) · [docs/GOAL.md](docs/GOAL.md)
- [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md) — tham chiếu đầy đủ 20 MCP tools (input schema, handler, return type, JSON-RPC example)
- [CLAUDE.md](CLAUDE.md) — project overview dành cho AI assistant

## Kết quả đánh giá

Đánh giá trên **30 ca Juliet CWE-401 (Memory Leak)**, baseline sweep
`baseline-sweep-2026-07-27T09-03-51`. Mỗi baseline LLM chạy 3 lần
(temperature 0) trên model **oc/deepseek-v4-flash-free**, git `b97483f`.

| ID | Baseline | Precision | Recall | F1 | FP/KLOC | ECE | Tokens/case | ms/case |
|----|----------|-----------|--------|----|---------|-----|-------------|---------|
| B1 | Static only | 77.4% | 72.7% | 0.750 | 0.733 | 0.517 | 0 | 161 |
| B2 | Dynamic only | 100.0% | 54.1% | 0.702 | 0.000 | 0.043 | 0 | 760 |
| B3 | Rule-based ensemble | 80.0% | 84.8% | 0.824 | 0.733 | 0.158 | 0 | 599 |
| B4 | LLM + static | 78.4% | 87.9% | 0.829 | 0.838 | 0.075 | 13496 | 11972 |
| B5 | LLM + dynamic | 100.0% | 55.9% | 0.717 | 0.000 | 0.004 | 468 | 1309 |
| B6 | LLM + all (no planner/selector) | 97.6% | 81.8% | 0.890 | 0.070 | 0.108 | 5745 | 7101 |
| B6a | + planner only | 97.6% | 82.8% | 0.896 | 0.070 | 0.125 | 5756 | 17233 |
| B6b | + tool_selector only | 95.3% | 80.8% | 0.874 | 0.140 | 0.118 | 50742 | 28467 |
| B7 | Proposed (full adaptive) | 95.3% | 80.8% | 0.874 | 0.140 | 0.110 | 44392 | 41230 |

File cấu hình baseline: `configs/baselines/b1-static-only.yaml` … `b7-proposed.yaml`.
Chi tiết: [docs/BASELINE-COMPARISON.md](docs/BASELINE-COMPARISON.md), [docs/EVALUATION.md](docs/EVALUATION.md).

## Tham khảo & Baseline

Chỉ liệt kê các công trình, công cụ, dataset mà **cleak thực sự dùng hoặc so sánh trực tiếp**.
Chi tiết từng paper (so sánh, số liệu, kiểm chứng): [docs/RELATED-WORK.md](docs/RELATED-WORK.md)
và [`researchs/`](researchs/). Đầy đủ 43 tham khảo có đánh số:
[paper/references/bibliography.md](paper/references/bibliography.md).

### A. Công cụ tích hợp (triển khai trực tiếp trong code)

- **Clang Static Analyzer** (scan-build) — phân tích tĩnh, tích hợp trong `static-analyzer`
- **Infer** (Facebook) — baseline so sánh
  (`apps/leak-inspector-tui/src/domain/baselines/infer.ts`)
- **Valgrind Memcheck** — phân tích động (`dynamic-analyzer`)
- **AddressSanitizer** (ASan) — phân tích động (`dynamic-analyzer`)
- **LeakSanitizer** (LSan) — phân tích động (`dynamic-analyzer`)
- **Tree-sitter** — parsing C/C++ AST (npm dep)
- **Model Context Protocol** (MCP) — giao thức transport (npm dep)
- **NestJS + Express** — framework backend
- **Ink + React** — TUI framework

### B. Baseline leak C/C++ (so sánh trực tiếp)

- **LAMeD** — EASE 2025 (CORE-A), peer-reviewed, baseline leak-only duy nhất có phản biện.
  Dùng AllocSource/FreeSink annotation — khái niệm cleak mượn làm `extraAllocators`/`extraDeallocators`.
- **MemHint** — arXiv 2026, neuro-symbolic static + Z3 + LLM-confirm, số liệu trên dự án thực
  (52–54 leak / 7 dự án).

### C. Hệ agentic (so sánh kiến trúc)

- **RepoAudit** — ICML 2025 poster, agent audit repo + SAT validator
- **FuzzingBrain V2** — arXiv 2026, multi-agent trên MCP, static + dynamic
- **ATLANTIS** — AIxCC 2025 winner, static + dynamic agentic
- **Buttercup** — Trail of Bits, static + dynamic agentic

### D. Nền tảng thiết kế

- **ReAct** (Yao et al., ICLR 2023) — nền tảng agent tool-calling loop
- **Self-Consistency** (Wang et al., ICLR 2023) — nền tảng consensus judge (k mẫu, bỏ phiếu)

### E. Corpus đánh giá

- **NIST Juliet CWE-401** (NIST SARD, public domain) — benchmark tổng hợp Tier-1, eval chính
- **LAMeD Zenodo artifact** (cJSON 152 hàm, DOI: 10.5281/zenodo.15089703) — corpus so sánh

---

> Xem thêm: [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md) — chi tiết từng MCP tool.
> [CLAUDE.md](CLAUDE.md) — overview dành cho AI assistant.
