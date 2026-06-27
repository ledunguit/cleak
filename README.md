# Thesis Workspace

Workspace gốc cho luận văn Thạc sĩ về **điều tra rò rỉ bộ nhớ C/C++ do LLM điều phối**.
Đây là workspace ô (umbrella), không phải một repo triển khai đơn lẻ — nó gom các thành
phần của luận văn ở cùng một cấp. `master` là **TUI-only** (bản web cũ đã tách nhánh).

> 📄 **Tài liệu luận văn:** bắt đầu ở **[docs/THESIS.md](docs/THESIS.md)** (đọc trước) —
> chỉ mục đầy đủ ở **[docs/README.md](docs/README.md)**.

## Định vị

`leak-investigator` = **tĩnh (MCP/Clang) + động (Valgrind/ASan/LSan) + điều phối agentic +
judge layer**, chuyên **memory leak C/C++**. Theo khảo sát 2025–2026 (xem `researchs/`),
*chưa có* hệ nào kết hợp **cả tĩnh lẫn động chuyên cho LEAK** trong C/C++ — đây là khoảng
trống mà luận văn nhắm tới. Chi tiết baseline & định vị: [§ Tham khảo](#tham-khảo--baseline).

## Thành phần

### `apps/leak-inspector-tui` — Scanner độc lập (Ink CLI/TUI) — ORCHESTRATOR
- Scanner agentic headless/tương tác; **điểm điều phối duy nhất**. Native tool-calling qua
  `packages/agent-core`.
- Workflow **HYBRID 4 pha**: (A) sub-agent tĩnh fan-out thu bằng chứng; (B) worker động
  build + chạy sanitizer, hoặc theo recipe tất định (`buildTarget → lsanRun`, không LLM);
  (C) tổng hợp; (D) hybrid judge (heuristic cho mọi bundle + LLM judge cho borderline +
  consensus tuỳ chọn trên k mẫu).
- Kết nối analyzer qua MCP; ghi artifact (JSON/Markdown/HTML/snapshot) vào `results/<scanId>/`.
- 📦 [apps/leak-inspector-tui/README.md](apps/leak-inspector-tui/README.md)

### `apps/static-analyzer` — Phân tích tĩnh (NestJS)
- Phục vụ **MCP Streamable-HTTP (cổng 50061)** cho TUI.
- Tree-sitter AST (C + C++), lexical scan, call graph, ownership, ràng buộc đường đi (Z3),
  **Clang Static Analyzer (`scan-build`)** tự chứa (submodule LeakGuard đã gỡ).
- 📦 [apps/static-analyzer/README.md](apps/static-analyzer/README.md)

### `apps/dynamic-analyzer` — Phân tích động (NestJS)
- Phục vụ **MCP Streamable-HTTP (cổng 50062)** cho TUI.
- Valgrind Memcheck, AddressSanitizer, LeakSanitizer (**Linux/Docker-only**).
- 📦 [apps/dynamic-analyzer/README.md](apps/dynamic-analyzer/README.md)

### `packages/agent-core` — Lõi agentic (thư viện TS)
- Vòng lặp native tool-calling không phụ thuộc framework, MCP client, `callModel` đa provider
  (streaming, idle-timeout, nén ngữ cảnh).
- 📦 [packages/agent-core/README.md](packages/agent-core/README.md)

### `packages/common` (`@cleak/common`) — Kiểu & judge dùng chung
- TypeScript types + Zod schema; heuristic judge + consensus judge + phân tích leak + độ đo
  đánh giá + render report. Dùng chung qua `@cleak/common`.
- 📦 [packages/common/README.md](packages/common/README.md)

> **MCP/HTTP là transport duy nhất.** Server gRPC + thư mục `proto/` của bản web cũ **đã bị
> xoá khỏi `master`** (không còn consumer sau khi bỏ control-plane). Tool I/O khai báo bằng
> Zod `inputSchema` ngay trong MCP server của từng analyzer.

## Luồng hệ thống

Một đường điều phối duy nhất: TUI (`leak-inspector-tui`) chạy vòng native tool-calling của
`agent-core`, gọi thẳng analyzer qua MCP và ghi artifact ra đĩa.

1. Analyzer tĩnh/động expose MCP tool
2. TUI điều phối điều tra trên một repo C/C++ mục tiêu
3. Findings được chuẩn hoá thành leak bundle dùng chung
4. Hệ trả verdict + giải thích + gợi ý sửa, render 4 định dạng report

Xem [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) cho thành phần/giao thức/diagram.

> Đường điều phối web cũ (`control-plane` + React SPA `leak-inspector-ui`) đã được gỡ khỏi
> `master`; bảo tồn ở nhánh `web-implementation`.

## Corpus demo

- `demo/memory_leak_corpus/` — ca kiểm thử cho đánh giá (`simple_leak`, `early_return_leak`,
  `ownership_maze`, …); mỗi ca biên dịch bằng `make CC=clang`.
- Nguồn corpus (Juliet, LAMeD) không commit — xem [docs/DATASETS.md](docs/DATASETS.md).

## Bắt đầu nhanh

1. Tạo `.env` cho từng service từ template (mọi biến tuỳ chọn — có default):

```bash
cp .env.example .env                                   # (tuỳ chọn) LLM config dùng chung
cp apps/static-analyzer/.env.example  apps/static-analyzer/.env
cp apps/dynamic-analyzer/.env.example apps/dynamic-analyzer/.env
cp apps/leak-inspector-tui/.env.example apps/leak-inspector-tui/.env   # điền LLM key ở đây
```

2. Bật analyzer (static + dynamic, MCP) bằng Docker Compose — mỗi container đọc `.env` riêng:

```bash
docker compose up --build
```

3. Chạy TUI scanner:

```bash
cd apps/leak-inspector-tui
bun install
bun run dev
```

## Build toàn bộ (Turbo)

```bash
bun run build
```

## Tài liệu

Bắt đầu ở **[docs/THESIS.md](docs/THESIS.md)**; chỉ mục đầy đủ ở **[docs/README.md](docs/README.md)**.

- [docs/THESIS.md](docs/THESIS.md) — tổng quan luận văn (đọc trước)
- [docs/CONTRIBUTION.md](docs/CONTRIBUTION.md) — đóng góp học thuật + kết quả
- [docs/RELATED-WORK.md](docs/RELATED-WORK.md) — baseline & related work (chi tiết từng paper)
- [docs/EVALUATION.md](docs/EVALUATION.md) — phương pháp đánh giá + tái lập
- [docs/BASELINE-COMPARISON.md](docs/BASELINE-COMPARISON.md) — runbook chạy so sánh baseline
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — chạy/tái lập end-to-end
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — thành phần, giao thức, diagram
- [docs/PROMPTS.md](docs/PROMPTS.md) — danh mục mọi prompt LLM + mô tả tool
- [docs/sequence-diagrams.md](docs/sequence-diagrams.md) — luồng tuần tự runtime
- [docs/GLOSSARY.md](docs/GLOSSARY.md) · [docs/DATASETS.md](docs/DATASETS.md) · [docs/SECURITY.md](docs/SECURITY.md) · [docs/GOAL.md](docs/GOAL.md)

## Tham khảo & Baseline

Các công trình/công cụ/dataset mà luận văn **so sánh (baseline)** hoặc **kế thừa**. Chi tiết
kỹ thuật + số liệu + log kiểm chứng đối kháng (3 phiếu/claim, có cả **claim bị bác bỏ**) ở
[docs/RELATED-WORK.md](docs/RELATED-WORK.md) và [`researchs/`](researchs/).

> ⚠️ Vài mục là **preprint arXiv 2026 rất mới** — kiểm lại venue/peer-review và số liệu từ
> PDF gốc trước bản nộp (xem `researchs/04-nguon-va-kiem-chung.md`).

**Baseline — leak C/C++ trực tiếp**
- **LAMeD** — *LLM-generated Annotations for Memory Leak Detection*. EASE 2025 (CORE-A,
  peer-reviewed). arXiv:2505.02376 · DOI:10.1145/3756681.3756999 · artifact Zenodo
  10.5281/zenodo.15089703. Baseline leak-only **đã phản biện duy nhất**; minh hoạ đánh đổi
  recall↑/FP↑.
- **MemHint** — neuro-symbolic static + Z3 + LLM-confirm. arXiv:2603.27224 (preprint). Số
  liệu leak C/C++ trên dự án thực (52–54 leak / 7 dự án).

**Baseline — analogue kiến trúc (agentic / judge / static+dynamic / MCP)**
- **RepoAudit** — agent audit repo + validator path-condition SAT. arXiv:2501.18160 (ICML
  2025 poster). Đa defect, đa ngôn ngữ (không leak-only).
- **FuzzingBrain V2** — multi-agent trên MCP, static + dynamic. arXiv:2605.21779 (preprint).
  Gần nhất về kiến trúc nhưng xác minh **bằng crash** (leak chỉ incidental).
- **ATLANTIS** (vô địch AIxCC 2025, arXiv:2509.14589) · **Buttercup** (Trail of Bits,
  AGPL-3.0) — hệ agentic static+dynamic; đều xác minh bằng crash → tương phản với lớp
  **non-crash leak** của luận văn.

**Phụ trợ — formal / dataset**
- **POM (CMU SEI)** — LLM gán nhãn pointer + SAT (hướng prevention). CMU/SEI-2025-TR-008.
- **SecVulEval** — dataset vuln C/C++ (25.4K hàm). arXiv:2505.19828.

**Dataset & corpus**
- **NIST Juliet CWE-401** — benchmark tổng hợp Tier-1 (NIST SARD, public domain).
- **DiverseVul** (wagner-group) — nguồn corpus dự án thực cho LAMeD.
- **LAMeD Zenodo artifact** — corpus cJSON 152 hàm gán nhãn leak (DOI ở trên).

**Công cụ kế thừa**
- Tĩnh: **Clang Static Analyzer (`scan-build`)** (tích hợp trực tiếp), **CodeQL**, **Infer**
  (baseline so sánh).
- Động: **Valgrind**, **AddressSanitizer**, **LeakSanitizer**.
- Hạ tầng: **Z3** (path feasibility) · **Tree-sitter** (AST C/C++) · **Model Context
  Protocol (MCP)** (chuẩn tool/transport cho mọi analyzer).
