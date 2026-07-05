# Phụ lục C: Cài đặt và hướng dẫn chạy

## C.1. Yêu cầu hệ thống

| Thành phần | Yêu cầu |
|---|---|
| OS | Linux (dynamic analysis); macOS/Linux (static only) |
| Docker | ≥ 20.10 (chạy analyzer) |
| Bun | ≥ 1.0 (runtime chính) |
| Node.js | ≥ 18 (fallback, không khuyến nghị) |
| Clang | ≥ 14 (compile test case Juliet, scan-build) |
| Valgrind | ≥ 3.18 (chỉ Linux, optional) |
| LLM Gateway | OpenAI-compatible endpoint (mặc định: localhost:20128) |

## C.2. Cài đặt

```bash
# Clone repo
git clone <repo-url> && cd leak-investigator

# Install dependencies
bun install

# Build all packages + apps
bun run build

# Start analyzers (Docker)
docker compose up --build -d

# Verify analyzers
curl -s http://localhost:50061/mcp  # static-analyzer
curl -s http://localhost:50062/mcp  # dynamic-analyzer
```

## C.3. Cấu hình LLM

Tạo file `.env` ở root hoặc `apps/leak-inspector-tui/.env`:

```bash
# Local gateway (mặc định)
LLM_PROVIDER=local
LLM_BASE_URL=http://localhost:20128/v1
LLM_API_KEY=not-needed
LLM_MODEL=mimo/mimo-v2.5-pro

# Hoặc OpenAI
# LLM_PROVIDER=openai
# LLM_API_KEY=sk-...

# Hoặc Anthropic
# LLM_PROVIDER=anthropic
# LLM_API_KEY=sk-ant-...
```

## C.4. Chạy đánh giá

```bash
# Single run — deterministic (no_llm)
bun scripts/evaluate-corpus.ts no_llm --corpus demo/juliet_cwe401 --dynamic selective

# LLM-assisted, 5 runs → mean ± std
bun scripts/evaluate-corpus.ts llm_assisted --corpus demo/juliet_cwe401 --runs 5

# 9-baseline sweep (stratified n=50)
bun scripts/run-baselines.ts --corpus demo/juliet_cwe401 --limit 50 --stratify

# So sánh với Clang SA
bun scripts/compare-baselines.ts --corpus demo/juliet_cwe401 --limit 30

# Determinism gate
bash scripts/determinism-gate.sh

# Consensus ablation
K=3 LIMIT=30 bash scripts/consensus-ablation.sh
```

## C.5. Cấu hình nâng cao

Mọi setting đều có thể cấu hình qua (thứ tự ưu tiên giảm dần):
1. CLI flags (`--provider`, `--model`, `--dynamic`, `--consensus-n`, v.v.)
2. Env vars (`LLM_PROVIDER`, `CONSENSUS_N`, `AGENT_MAX_TURNS`, v.v.)
3. Config file `~/.config/cleak/config.json`
4. Default values trong `apps/leak-inspector-tui/src/config.ts`

Xem thêm: `cleak config` (hiển thị cấu hình hiện tại) hoặc lệnh `/config` trong TUI.

## C.6. Cấu trúc output

Mỗi lần scan tạo `results/<scanId>/` chứa:

| File | Nội dung |
|---|---|
| `snapshot.json` | Findings format chuẩn (so sánh được giữa các run) |
| `report.json` | Full report với verdict, evidence, explanation |
| `report.md` | Báo cáo Markdown |
| `report.html` | Báo cáo styled HTML |
| `events.jsonl` | Stream events (tăng dần) |
| `transcript.json` | Lịch sử message agent |
| `steps.md` | Log từng bước |
| `metrics.json` | Phân bố verdict, token, thời lượng |
