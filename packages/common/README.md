# @cleak/common

Thư viện **dùng chung** cho cả workspace: kiểu dữ liệu + **Zod schema**, **judge layer**
(heuristic + consensus), phân tích rò rỉ, đối chiếu bằng chứng động, **độ đo đánh giá**, và
**bộ render report**. Đây là nơi đặt **ranh giới quyết định leak-vs-clean** — phần lõi học
thuật của luận văn — để mọi orchestrator/script dùng chung một logic, một schema.

Publish lên npm (`@cleak/common`); build bằng `tsup`. Không thực thi gì, **không đọc env**.

## Bố cục & subpath export

```
src/
  index.ts                         → "@cleak/common"            (types + validation + scan-flow-contract)
  types/leak-schema.types.ts       LeakCandidate, LeakBundle, Evidence, Verdict, …  ("@cleak/common/types")
  validation/                      Zod schema cho I/O analyzer + verdict
  flow/scan-flow-contract.ts       ScanEvent/ScanEventName, hợp đồng pha scan ("@cleak/common/flow/scan-flow-contract")
  analysis/                        ("@cleak/common/analysis/*")
    heuristic-judge.ts             judgeHeuristically() — chốt verdict tất định cho MỌI bundle
    consensus-judge.ts             judgeByConsensus() — k mẫu LLM + luật gộp (điểm novelty)
    heuristic-leak-analysis.ts     analyzeLeakHeuristically(), enrichLeakVerdict(), repair suggestion
    dynamic-evidence.ts            correlateEvidence(), firstUserFrame(), normalizeLeakKind()
    judge-shared.ts                ngưỡng + chuỗi verdict dùng chung (JUDGE_VERDICT_THRESHOLDS, …)
    metrics.ts                     computeMetrics(), mcnemar(), bootstrapCI(), calibration/ECE
    reporting.ts                   LeakReporting — render JSON / Markdown / HTML / snapshot
```

> **Lưu ý import:** `analysis/*` **không** re-export ở root. Dùng subpath, ví dụ
> `import { judgeHeuristically } from '@cleak/common/analysis/heuristic-judge'`.

## API tiêu biểu

| Symbol | Module | Vai trò |
|---|---|---|
| `judgeHeuristically(...)` | `analysis/heuristic-judge` | verdict tất định cho mọi bundle (heuristic) |
| `judgeByConsensus(...)` | `analysis/consensus-judge` | gộp k mẫu LLM judge (`ConsensusConfig`, luật majority/weighted/unanimous) |
| `analyzeLeakHeuristically`, `enrichLeakVerdict`, `buildRepairSuggestion` | `analysis/heuristic-leak-analysis` | phân tích + làm giàu verdict + gợi ý sửa |
| `correlateEvidence`, `firstUserFrame`, `normalizeLeakKind`, `deriveDynamicFields` | `analysis/dynamic-evidence` | đối chiếu bằng chứng động ↔ ứng viên tĩnh |
| `computeMetrics`, `mcnemar`, `bootstrapCI`, `expectedCalibrationError` | `analysis/metrics` | confusion matrix, kiểm định McNemar, CI bootstrap, ECE |
| `LeakReporting` | `analysis/reporting` | render report 4 định dạng |
| `LeakCandidate`, `LeakBundle`, `Evidence`, `Verdict` | `types` | schema bó dữ liệu chia sẻ giữa các app |
| `ScanEvent`, `ScanEventName` | `flow/scan-flow-contract` | hợp đồng sự kiện pha scan |

## Mô hình verdict (tóm tắt)

Heuristic chấm điểm bằng chứng (tĩnh + động) → ánh xạ qua `JUDGE_VERDICT_THRESHOLDS` thành
verdict; bundle **borderline** mới đẩy lên LLM judge / consensus. Bằng chứng động
`exercised_clean` kích hoạt **cổng minh oan** (giảm FP), `definitely_lost` tương quan thì
cộng điểm. Chi tiết: [docs/EVALUATION.md](../../docs/EVALUATION.md) ·
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

## Build / test

```bash
turbo run build --filter=@cleak/common    # tsup (nhiều entry: index/types/flow/analysis)
turbo run test  --filter=@cleak/common    # bun test
```
