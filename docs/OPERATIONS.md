# Vận hành & tái lập (Operations runbook)

> Cách khởi động hệ thống, chạy quét, chạy đánh giá, và **tái lập các kết quả** trong
> luận văn. Định nghĩa metric & giao thức: [EVALUATION.md](EVALUATION.md). So sánh baseline:
> [BASELINE-COMPARISON.md](BASELINE-COMPARISON.md).

---

## 1. Khởi động stack

```bash
# Từ repo root — dựng hai analyzer (static + dynamic, chế độ MCP)
docker compose up --build
```
- **Cổng MCP của analyzer (Docker): static `50061`, dynamic `50062`.** TUI (orchestrator)
  chạy ngoài Docker và gọi vào hai cổng này.

> Stack chỉ gồm `static-analyzer` + `dynamic-analyzer` (MCP). Đường web cũ
> (control-plane + UI React) đã được gỡ khỏi master, còn lưu trên nhánh
> `web-implementation`.

> ⚠️ **GOTCHA cổng MCP.** `scripts/evaluate-corpus.ts` **mặc định** trỏ `50071/50072`
> (một setup dev-server cũ). Khi dùng stack Docker, **luôn đặt**:
> ```bash
> export EVAL_STATIC_URL=http://127.0.0.1:50061/mcp
> export EVAL_DYNAMIC_URL=http://127.0.0.1:50062/mcp
> ```
> Trỏ sai cổng → mọi ca lỗi "Static analyzer MCP server is unreachable" (gate determinism
> nay **từ chối** loại lỗi này thay vì báo "đậu giả" — xem §4).

Kiểm tra nhanh analyzer sống:
```bash
curl -s -m 3 -X POST http://127.0.0.1:50061/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 120
```

## 2. Chạy quét một repository

### 2a. TUI tương tác
```bash
cd apps/leak-inspector-tui
bun src/cli.ts                       # mở TUI (lệnh mặc định)
# trong TUI:  /scan <path-repo>  ·  /report [scanId]  ·  /config  ·  /eval <corpus> [N]
```
- `/config` chọn **provider** (`local | openai | anthropic | openai-compat`) và sửa
  **Base URL / Model / API key** ngay trong UI (lưu `~/.config/leak-inspector/prefs.json`,
  chmod 600). Provider **`openai-compat`** trỏ tới mọi endpoint kiểu OpenAI `/chat/completions`
  (LM Studio, vLLM, Ollama, OpenRouter, gateway riêng).

### 2b. Headless (CI / script)
```bash
cd apps/leak-inspector-tui
# Heuristic (không LLM) — nhanh, tất định
bun src/cli.ts scan --repo <path> --mode no_llm

# LLM-assisted với endpoint OpenAI-compatible tuỳ chỉnh
bun src/cli.ts scan --repo <path> --mode llm_assisted \
  --provider openai-compat --base-url http://localhost:1234/v1 --model qwen2.5-coder-32b
```
Báo cáo ghi vào `results/<scanId>/` (`report.{json,md,html}`, `snapshot.json`, `steps.md`).

## 3. Chạy đánh giá (eval)

```bash
# Từ repo root, với analyzer Docker:
export EVAL_STATIC_URL=http://127.0.0.1:50061/mcp EVAL_DYNAMIC_URL=http://127.0.0.1:50062/mcp

# Baseline tất định (heuristic), 30 ca Juliet
bun scripts/evaluate-corpus.ts no_llm --limit 30

# LLM-assisted, 5 lần chạy → mean ± std (variance.json / variance.md)
bun scripts/evaluate-corpus.ts llm_assisted --limit 30 --runs 5

# Bật consensus (k=3) + chọn rule
bun scripts/evaluate-corpus.ts llm_assisted --limit 30 --consensus-n 3 --consensus-rule weighted
```
Artifacts mỗi lần chạy: `results/eval-<mode>-<ts>/` → `metrics.json` (đầy đủ `EvalResult` +
provenance), `metrics.csv`, `rows.csv`, `report.md`, `tables.tex`.

> `--mode llm_assisted` cần endpoint LLM hợp lệ; nếu thiếu key cho provider cloud → eval
> **fail loud** ngay đầu (chống lẫn lộn `llm_assisted == no_llm`). `openai-compat` thiếu
> base URL/model cũng fail loud. Dùng `--allow-heuristic-fallback` để cố tình bỏ qua.

## 4. Tái lập các kết quả luận văn

```bash
export EVAL_STATIC_URL=http://127.0.0.1:50061/mcp EVAL_DYNAMIC_URL=http://127.0.0.1:50062/mcp
```

**Tier-1 — `no_llm` tất định bit-for-bit:**
```bash
bash scripts/determinism-gate.sh         # 2 lần chạy no_llm vào 2 thư mục TÁCH BIỆT → assert
# Kỳ vọng: ✓ DETERMINISTIC · overall {tp:29,fp:7,fn:3,tn:38}
```

**Tier-2 — verdict-stability (dao động LLM):**
```bash
bun scripts/evaluate-corpus.ts llm_assisted --limit 30 --runs 2     # hoặc 2 lần chạy riêng
bun scripts/verdict-stability.ts <runA> <runB>                      # dir hoặc metrics.json
# Báo: case-level stability, verdict flip rate, modal agreement, cờ "stable-by-luck"
```

**Headline ablation — consensus giảm dao động:**
```bash
K=3 LIMIT=30 bash scripts/consensus-ablation.sh
# single-LLM (n=1) ×2 vs consensus (n=3) ×2 → so flip rate
# Kỳ vọng: single ~26.7% → consensus ~6.7% (giảm ~4×)
```

**So sánh với baseline (clang-analyzer/infer):** xem [BASELINE-COMPARISON.md](BASELINE-COMPARISON.md).

## 5. Tái lập "trong ~30 phút" (chuỗi tối thiểu)
```bash
docker compose up --build -d
export EVAL_STATIC_URL=http://127.0.0.1:50061/mcp EVAL_DYNAMIC_URL=http://127.0.0.1:50062/mcp
bash scripts/determinism-gate.sh                       # (1) Tier-1 tất định
K=3 LIMIT=30 bash scripts/consensus-ablation.sh        # (2) headline consensus 4×
bun scripts/compare-baselines.ts --corpus demo/juliet_cwe401 --limit 30 --out results/baseline  # (3) vs clang
```

## 6. Biến môi trường chính
| Biến | Mục đích | Mặc định |
|---|---|---|
| `EVAL_STATIC_URL` / `EVAL_DYNAMIC_URL` | URL MCP analyzer cho eval | `:50071` / `:50072` (đặt `:50061`/`:50062` cho Docker) |
| `LLM_PROVIDER` | provider mặc định | `local` |
| `OPENAI_COMPAT_BASE_URL` / `_MODEL` / `_API_KEY` | endpoint OpenAI-compatible | (rỗng) |
| `CONSENSUS_N` / `CONSENSUS_RULE` / `CONSENSUS_TEMPERATURE` | knob consensus judge | `1` / `weighted` / `0.7` |
| `RESULTS_DIR` | thư mục output eval | `results` |
| `CLANG_BIN` / `INFER_BIN` | binary baseline | `clang` / `infer` |
