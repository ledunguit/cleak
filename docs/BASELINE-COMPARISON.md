# Runbook — So sánh với baseline

> Cách chạy so sánh **thực nghiệm** giữa hệ thống và các baseline cài-được (Clang Static
> Analyzer, Infer) trên **cùng corpus + cùng scorer**. Các paper baseline (MemHint, LAMeD,
> …) ở [RELATED-WORK.md](RELATED-WORK.md). Định nghĩa metric: [EVALUATION.md](EVALUATION.md).

---

## 1. Nguyên tắc công bằng

Mọi tool — hệ thống lẫn baseline — đều cho finding → **chuẩn hoá về `SnapshotFinding[]`** →
chấm bằng **đúng một** `scoreCase` (`apps/leak-inspector-tui/src/domain/evalScoring.ts`) trên
**đúng một** corpus. Nhờ vậy so sánh là **fair theo định nghĩa**. Baseline nào chưa cài thì
**bỏ qua sạch** (không bịa số).

## 2. Harness

| Thành phần | File | Vai trò |
|---|---|---|
| Compare baseline ↔ hệ thống | `scripts/compare-baselines.ts` | Chạy mọi baseline KHẢ DỤNG trên corpus, chấm bằng `scoreCase`, fold-in run hệ thống qua `--system`, in bảng md/CSV |
| Compare nhiều run | `scripts/compare-results.ts` | So ≥2 `metrics.json` (ablation mode/tool), in bảng Markdown + LaTeX |
| Adapter (interface) | `domain/baselines/adapter.ts` | `name` · `available()` · `run(caseDir,case) → SnapshotFinding[]` |
| Clang | `domain/baselines/clangAnalyzer.ts` | Chạy `clang --analyze` (binary host, không cần build); parse cảnh báo `unix.Malloc`/`cplusplus.NewDelete`; `verdict_tool='clang-analyzer'` |
| Infer | `domain/baselines/infer.ts` | `infer run -- <build_command>` (cần build_command); đọc `report.json`, lọc `*MEMORY_LEAK*` |
| Vòng eval baseline | `domain/baselines/runBaselineEval.ts` | Map `scoreCase` + bootstrap CI + `caseLoc` (mẫu số FP/KLOC, khớp `countSourceLoc` của hệ thống) |

`available()` gating: Clang có sẵn (`clang --version`); Infer **bị bỏ qua** nếu không cài.

## 3. Luật công bằng (đọc kỹ khi báo cáo)

- **Cùng `scoreCase` + cùng corpus** cho tất cả.
- **Tool "positive-only" (clang, infer) → TN = 0** (chúng chỉ liệt kê leak, không liệt kê
  site sạch). Vì vậy **bỏ FPR / specificity / MCC** khỏi bảng (không so được); chỉ so
  **Precision / Recall / F1 / số FP thô / FP/KLOC**. (Hệ thống *có* liệt kê site sạch nên
  có TN > 0 — cột TN in ra để minh bạch, không dùng để so trực tiếp.)
- **FP/KLOC**: mẫu số là dòng không trống trong file `.c/.cc/.cpp/.cxx` (loại header), một
  định nghĩa duy nhất cho mọi hệ.

## 4. Chạy

```bash
# (tuỳ chọn) chạy một eval hệ thống trước để fold-in
export EVAL_STATIC_URL=http://127.0.0.1:50061/mcp EVAL_DYNAMIC_URL=http://127.0.0.1:50062/mcp
bun scripts/evaluate-corpus.ts no_llm --limit 30          # → results/eval-no_llm-<ts>/metrics.json

# so baseline (clang/infer) + fold-in run hệ thống:
bun scripts/compare-baselines.ts --corpus demo/juliet_cwe401 --limit 30 \
  --system "no_llm=results/eval-no_llm-<ts>/metrics.json" \
  --out results/baseline-compare
cat results/baseline-compare/baseline-compare.md
```
`compare-baselines.ts` chạy **trực tiếp clang** trên từng case (không cần MCP analyzer);
chỉ cần `clang` trên PATH (hoặc `CLANG_BIN`).

## 5. Kết quả thực (Juliet CWE-401, 30 ca đầu)

Chạy thật trong dự án (analyzer Docker; Infer không cài → bỏ qua):

| Tool | sites | TP | FP | FN | TN | Precision | Recall | **F1** | FP/KLOC |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| **no_llm** (heuristic) | 77 | 29 | 7 | 3 | 38 | 0.806 | 0.906 | **0.853** | **0.741** |
| **consensus** (×3/weighted) | 77 | 30 | 10 | 2 | 35 | 0.750 | 0.938 | **0.833** | 1.058 |
| clang-analyzer | 44 | 27 | 12 | 5 | 0 | 0.692 | 0.844 | **0.761** | 1.270 |

> *FPR / specificity / MCC bị bỏ:* clang là positive-only (TN=0). Đọc theo Precision/Recall/F1
> + FP/KLOC. Infer: not installed — SKIPPED (trích số đã công bố trong [RELATED-WORK.md](RELATED-WORK.md)).

**Đọc bảng:** trên Juliet CWE-401, **cả hai cấu hình hệ thống thắng Clang về F1**
(no_llm 0.853 / consensus 0.833 **>** clang 0.761) và **ít false positive hơn theo KLOC**
(0.741 / 1.058 **<** 1.270). Lưu ý clang chỉ enumerate 44 site (leak nó tìm thấy) trong khi
hệ thống enumerate 77 site (gồm cả site sạch → đo được FP trên code sạch). Đây là corpus
*dễ* nơi heuristic mạnh; xem [CONTRIBUTION.md §Bàn luận](CONTRIBUTION.md) cho threats-to-validity.

## 5b. Chạy trên benchmark LAMeD (baseline peer-review, ca KHÓ)

LAMeD (EASE'25) là baseline leak C/C++ peer-review duy nhất, và là **dự án thật**
(curl/libtiff/cjson/…) — nơi giá trị của LLM/consensus + correlation siết kỳ vọng thể hiện
(ngược với Juliet *dễ*). Lấy + ingest theo [DATASETS.md](DATASETS.md):

```bash
bun scripts/lamed/ingest.ts                 # clone 7 repo tại bug commit → demo/lamed/cases/
bun scripts/evaluate-corpus.ts no_llm        --corpus demo/lamed   # → metrics.json
bun scripts/evaluate-corpus.ts llm_assisted  --corpus demo/lamed --consensus-n 3
```

**Luật công bằng cho LAMeD = giống §3 (positive-only):** benchmark **không có nhãn sạch**
(41 ca toàn leak đã xác nhận, mức *function*), nên **chỉ báo Recall + FP count + FP/KLOC**,
**bỏ** specificity/MCC/accuracy (TN=0 theo cấu trúc — như clang/infer). 6/41 ca chỉ có nhãn
mức-file (không scoreable ở function mode → báo rõ, không drop). So với LAMeD: họ báo P/R (no
F1) và đếm bug/43 qua CodeQL/Cooddy/Infer — đối chiếu trên **Recall + số bug bắt được**, không
phải F1.

**Kết quả — mốc BAN ĐẦU vs SAU khi build path-sensitive engine:**
- **Ban đầu** (không allocator annotation, judge lexical): `no_llm` **recall 0.000 — TP0/43** trên cả 7
  project. Phù hợp văn liệu — LAMeD cũng chỉ bắt **5–10/43** và *chỉ sau khi* thêm LLM-generated
  allocator annotations vào static analyzer thật (Cooddy/CodeQL/Infer); lexical-không-annotation → ~0 là
  kỳ vọng được.
- **SAU** (allocator profile per-project ≈ AllocSource + discovery + **judging path-sensitive**): trên
  cjson đã bắt **`merge_patch` → recall 0 → 1/6, FP 0** — rò tham số `target` trên đường lỗi, qua
  guard-subset reconciliation + Z3 feasibility + parameter-ownership. Đây là leak dự-án-thực ĐẦU TIÊN hệ
  bắt được, chứng minh discovery + path-sensitive judging hoạt động. **Re-run đầy đủ 41/41 với engine mới**
  (+ allocators per-project) là phép đo còn lại; 5 ca cjson còn miss = deallocator-semantics (const-skip) +
  control-flow vòng lặp lồng (xem [CONTRIBUTION.md](CONTRIBUTION.md)).

Đây *biện minh* định vị luận văn: cần allocator profile (giờ LLM khám phá động, ≈ LAMeD AllocSource) +
judging path-sensitive/interprocedural — đúng hướng LAMeD, và đã hiện thực được lớp đầu.

## 6. Các script đánh giá liên quan

| Script | Mục đích | Lệnh |
|---|---|---|
| `evaluate-corpus.ts` | Eval corpus (1 hoặc N run), ghi metrics/report/tables | `bun scripts/evaluate-corpus.ts [no_llm\|llm_assisted] [--limit N] [--runs M] [--dynamic ..] [--consensus-n K]` |
| `compare-baselines.ts` | Baseline ↔ hệ thống (bảng) | `bun scripts/compare-baselines.ts --corpus <dir> [--limit N] [--system L=path] [--out dir]` |
| `compare-results.ts` | So ≥2 run (md+LaTeX) | `bun scripts/compare-results.ts <runA> <runB> [--label L] [--out f]` |
| `compare-modes.ts` | no_llm vs llm_assisted | `bun scripts/compare-modes.ts [N]` |
| `assert-determinism.ts` | Gate Tier-1 (so chấm điểm 2 run) | `bun scripts/assert-determinism.ts <A>/metrics.json <B>/metrics.json` |
| `determinism-gate.sh` | Wrapper 2 run no_llm → assert | `bash scripts/determinism-gate.sh` |
| `verdict-stability.ts` | Tier-2 (flip rate) | `bun scripts/verdict-stability.ts <A> <B> [..]` |
| `consensus-ablation.sh` | single vs consensus (flip rate) | `K=3 LIMIT=30 bash scripts/consensus-ablation.sh` |

Corpus: xem [DATASETS.md](DATASETS.md) (Juliet CWE-401 + real_projects) và lệnh ingest.
