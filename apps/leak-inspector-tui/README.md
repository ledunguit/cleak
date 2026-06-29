# cleak

Trình **điều tra rò rỉ bộ nhớ C/C++** dạng agentic chạy trong terminal. Nó điều phối các MCP
server phân tích **tĩnh/động** bằng vòng lặp **native tool-calling** — mô hình tự quyết định
chạy phân tích nào trên mỗi ứng viên cấp phát, thu bằng chứng, ghi verdict — rồi render
report **JSON / Markdown / HTML / snapshot**. Một binary, hai mặt (TUI tương tác + batch
headless), artifact tái lập được theo từng scan. **Đây là orchestrator duy nhất** của hệ.

## Cài đặt

```bash
npm i -g @cleak/cli     # hoặc: bun add -g @cleak/cli  ·  pnpm add -g @cleak/cli
# lệnh sau khi cài vẫn là `cleak`
```

Sau đó:

```bash
cleak tui                                        # TUI tương tác
cleak scan --repo <path> --mode llm_assisted     # scan headless → results/<scanId>/
cleak tools                                      # kiểm tra kết nối MCP của analyzer
cleak eval --corpus <path>                       # đánh giá batch một corpus đã gán nhãn
```

`cleak` cần 2 MCP server analyzer chạy sẵn (mặc định `localhost:50061` / `50062`) — bật bằng
`docker compose up` từ repo, hoặc trỏ tới server từ xa qua `--static-url` / `--dynamic-url`.
Key/provider LLM đọc từ `<cwd>/.env`, `apps/leak-inspector-tui/.env` hoặc biến môi trường
(`LLM_PROVIDER`, `LOCAL_LLM_API_KEY` / `OPENAI_API_KEY` / …).

### Từ source (trong monorepo này)

```bash
bun run cleak:install     # build bundle tự chứa + npm i -g
```

## Kiến trúc

```
packages/agent-core         lõi agentic không phụ thuộc framework (tái dùng được):
  loop.ts                   queryLoop(): vòng lặp lượt (stream → tool → kết quả → lặp)
  tool.ts                   trừu tượng Tool + buildTool()
  providers/                callModel cho local | openai | anthropic | openai-compat
  mcp/                      MCP client Streamable-HTTP + bọc tool (tools/list → Tool)

apps/leak-inspector-tui
  domain/                   systemPrompt, tool nghiệp vụ (read_file, record_verdict, …),
                            CandidateManager, path resolver, dynamicEvidence, wrapper judge
  orchestrator/             scanController HYBRID + ScanEvent emitter + pha investigation
  surfaces/headless.ts      batch runner → results/<scanId>/ + log sự kiện JSONL
  surfaces/tui/             UI Ink (timeline, tool card, spinner, overlay xin phép)

packages/common/analysis    render report + phân tích heuristic + heuristic judge +
                            consensus judge (ranh giới quyết định leak-vs-clean)
```

### Điều phối HYBRID

```
discovery (tất định: indexFiles + candidateScan)
  → static-enrichment (tất định, opt-in STATIC_ENRICH)
  → investigation (vòng native tool-calling agentic; CHỈ mode llm_assisted)
  → dynamic tất định (build → LSan, KHÔNG LLM; mode no_llm khi --dynamic ≠ off + có buildCommand)
  → judging (heuristic chốt cho mọi bundle + LLM judge cho borderline + consensus tuỳ chọn)
  → reporting (json / markdown / html / snapshot)
```

Discovery + judging tất định giữ tập ứng viên và tổng hợp verdict **tái lập được**; pha
investigation là nơi mô hình thực sự agentic.

## Sử dụng (trong monorepo)

Bật analyzer (MCP là transport duy nhất):

```bash
(cd apps/static-analyzer  && MCP_HTTP_PORT=50061 bun run dev)
(cd apps/dynamic-analyzer && MCP_HTTP_PORT=50062 bun run dev)
# hoặc đơn giản: docker compose up --build
```

Rồi:

```bash
# liệt kê/kiểm tra tool của analyzer
bun apps/leak-inspector-tui/src/cli.ts tools

# scan headless (ghi results/<scanId>/)
bun apps/leak-inspector-tui/src/cli.ts scan --repo demo/memory_leak_corpus/early_return_leak --mode llm_assisted

# TUI tương tác (cần terminal)
bun apps/leak-inspector-tui/src/cli.ts tui
#   /scan <path>  /mode no_llm|llm_assisted  /dynamic off|selective|aggressive  /report  /tools  /quit
```

### Output (`results/<scanId>/`)

- `snapshot.json` — findings gọn, so sánh được bằng máy (định dạng đánh giá luận văn)
- `report.json` / `report.md` / `report.html` — report đầy đủ
- `events.jsonl` — luồng ScanEvent (pha + hoạt động agent)
- `transcript.json` — toàn bộ lịch sử message của agent (tái lập / audit)

## Cấu hình (ENV)

Copy [`.env.example`](.env.example) → `.env` rồi điền. **Mọi biến TUỲ CHỌN** trừ key của
provider bạn chọn. Bảng rút gọn (đầy đủ trong `.env.example`):

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `LLM_PROVIDER` | `local` \| `openai` \| `anthropic` \| `openai-compat` | `local` |
| `LOCAL_LLM_BASE_URL` / `LOCAL_LLM_MODEL` / `LOCAL_LLM_API_KEY` | gateway OpenAI-compatible cục bộ | `localhost:20128/v1` |
| `STATIC_ANALYZER_MCP_URL` / `DYNAMIC_ANALYZER_MCP_URL` | endpoint analyzer | `localhost:50061` / `:50062` |
| `AGENT_MAX_TURNS` | ngân sách lượt investigation | `15` |
| `CONSENSUS_N` / `CONSENSUS_RULE` | judge consensus (n=1 ⇒ judge đơn) | `1` / `weighted` |

Key LLM đọc tự động từ `<repo-root>/.env` hoặc `apps/leak-inspector-tui/.env` khi khởi động.
Chạy trên host sẽ rewrite `host.docker.internal` → `localhost`; đặt `IN_CONTAINER=1` để giữ
hostname container.

## Cấu hình qua config file (`cleak config`)

Khi cài global (`npm i -g @cleak/cli`) và chạy ngoài monorepo, **không cần `.env`** — mọi
setting của `RunConfig` (kể cả **endpoint analyzer** `staticUrl`/`dynamicUrl`, provider, LLM
tuning, workflow, consensus) chỉnh được qua một **config file** tại
`~/.config/cleak/config.json` (tôn trọng `$XDG_CONFIG_HOME`; `chmod 600` vì có thể chứa key).

```bash
cleak config path                              # in đường dẫn file
cleak config init                              # ghi template đủ key
cleak config set staticUrl http://host:50061/mcp
cleak config set consensus.n 3
cleak config set endpoints.openai.apiKey sk-…  # key được lưu, mask khi `get`
cleak config get [key] [--json] [--show-secrets]   # in config đã RESOLVE (mask apiKey mặc định)
cleak config unset <key>
```

Trong TUI, lệnh **`/config`** mở màn hình settings cho **toàn bộ** knob (theo từng section).

**Thứ tự ưu tiên:** `CLI flag` > **biến env** (gồm cả `.env` của monorepo) > **config file** >
default. Tức là env vẫn thắng config file — tiện cho workflow `.env`/CI; còn người cài global
(không có env) thì config file là nguồn cấu hình.

## Script thực nghiệm luận văn

```bash
bun scripts/evaluate-corpus.ts [no_llm|llm_assisted] [limit]   # chấm điểm vs expected_leak_count
bun scripts/compare-modes.ts [limit]                           # no_llm vs llm_assisted
bun scripts/run-local-scan-smoke.ts                            # sanity 1 scan
bun scripts/mcp-contract-test.ts                               # kiểm catalog tool analyzer
```

## Ghi chú

- **Phân tích động** (sanitizer / valgrind) và slot **Clang-SA / scan-build** cần Linux/Docker;
  trên macOS các pha đó chạy trong container. Agent gate sau `--dynamic` + xin phép tương tác.
  (Slot "scan-build" giờ chạy Clang scan-build, không phải tool LeakGuard third-party đã gỡ.)
- **MCP/HTTP là transport duy nhất** — server gRPC + `proto/` của bản web cũ đã bị xoá khỏi
  `master`. Nếu cổng `50061/50062` đang bận, chạy analyzer ở cổng khác (vd `50071/50072`) rồi
  truyền `--static-url` / `--dynamic-url`.
