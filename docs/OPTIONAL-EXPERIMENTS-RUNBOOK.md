# Optional-experiments runbook: O1-O4 + I7-residual (REVIEW O-pack)

> **Trạng thái: PREPARED, CHƯA CHẠY.** Năm thí nghiệm tùy chọn, xếp theo thứ tự
> ưu tiên giảm dần: O1 > O2 > I7-residual > O3 > O4. Không thí nghiệm nào trong
> số này là điều kiện cần cho số headline đã đông cứng (RESULTS-FREEZE); mỗi
> mục ghi sẵn chỗ trả số về trong luận văn nếu chạy. Prereq chung cho mọi mục
> có LLM/analyzer: `docker compose up --build -d` + `export
> EVAL_STATIC_URL=http://127.0.0.1:50061/mcp EVAL_DYNAMIC_URL=http://127.0.0.1:50062/mcp`.

---

## O1. B6a-zai run 2/2 (hoàn tất sweep glm-5.2 trên full corpus)

**Bối cảnh:** sweep B6a provider `z-ai` (model `glm-5.2`) trên corpus Juliet đầy
đủ 1658 ca đã khởi động 2026-08-19 nhưng dở:
`results/baseline-sweep-B6a-zai-2026-08-19T04-25-01/B6a/run-1/` có đủ 1658
case cache (chưa tổng hợp `metrics.json`) và `run-2/` mới có 22/1658 ca. Ch4
§4.1.6 hiện đang báo trung thực: "F1 0.774 (run 1/2 hoàn tất, số derive từ
per-case rows)".

**Lệnh (tiếp tục đúng sweep cũ, `--resume` tái dụng case cache):**

```bash
pnpm exec tsx evaluation/cli.ts \
  --corpus demo/juliet_cwe401 \
  --baseline B6a \
  --provider z-ai \
  --runs 2 \
  --resume \
  --concurrency 16 \
  --out-dir results/baseline-sweep-B6a-zai-2026-08-19T04-25-01
```

(Giữ nguyên mọi tham số của lần chạy gốc: cùng corpus, cùng provider profile
`z-ai`, cùng out-dir. `--concurrency` chỉ ảnh hưởng wall-clock.)

**Kết quả mong đợi:**

- `B6a/run-1/metrics.json` + `B6a/run-2/metrics.json` + `B6a/variance.json`
  (mean ± std F1/P/R trên 2 run đầy đủ) và `baseline-sweep.{md,csv,json}` ở
  thư mục gốc sweep.
- Console dòng tổng kết dạng `── B6a …: P …% R …% F1 0.7xx · FP/KLOC … · … MCP/case`.
- Số trả về **§4.1.6**: thay câu "(run 1/2 hoàn tất, số derive từ per-case
  rows)" bằng mean ± std thật của 2 run, ví dụ "glm-5.2 (z-ai) cho F1
  0.7xx ± 0.0xx (2 run đầy đủ)". Khoảng F1 liên-model 0.737-0.863 trong cùng
  đoạn có thể được siết lại theo số mới.

**S5. Fallback nếu KHÔNG chạy kịp trước freeze:** sửa §4.1.6 để dán nhãn
không-kết-luận thay vì bỏ số. Câu thay thế (chèn đúng chỗ đang nói glm-5.2):

> "`glm-5.2` (z-ai): 0.774 trên **một run chưa tổng hợp** (per-case rows, run
> thứ hai dở dang 22/1658 ca); số này là dữ liệu phụ mô tả độ rộng liên-model,
> không kết luận được variance và không dùng làm bằng chứng robustness."

Đồng thời bảo đảm mọi chỗ trích "0.774" trong docs/ chép kèm chữ
"đơn-run, chưa tổng hợp". KHÔNG xóa số (nó đang trung thực), chỉ siết nhãn.

---

## O2. Consensus k ∈ {5, 7} (mở rộng đường cong k sau reversal n=50)

**Bối cảnh:** reversal đã chốt ở k=3 (single 2.0% flip / F1 0.852 so với
consensus 8.0% / 0.793, n=50 stratified, McNemar p=0.077, xem bảng ở mục
"Bối cảnh" của [DEFENSE-PLAN.md](DEFENSE-PLAN.md)). Thí nghiệm này đo thêm hai
điểm k=5 và k=7 để xem xu hướng theo k là dập churning hay tích lũy nhiễu.

**Lệnh (dùng đúng `scripts/consensus-ablation.sh`, mỗi k một lời gọi):**

```bash
K=5 LIMIT=50 STRATIFY=1 OUT=results/consensus-ablation-n50-k5 bash scripts/consensus-ablation.sh
K=7 LIMIT=50 STRATIFY=1 OUT=results/consensus-ablation-n50-k7 bash scripts/consensus-ablation.sh
```

Script tự chạy 4 run llm_assisted trên cùng 50 ca (single-LLM ×2, consensus-k
×2, `--no-judge-cache` có sẵn trong script) rồi in hai bảng flip-rate và một
McNemar single-vs-consensus.

**Kết quả mong đợi:**

- Console: `══════ SINGLE-LLM (n=1) stability ══════` (flip %), `══════ CONSENSUS
  (n=K) stability ══════` (flip %), `══════ McNemar ══════` (b01/b10, χ², p).
- Điểm k=5, k=7 nối vào đường cong k đã có k=1 (2.0%) và k=3 (8.0%). Hai kết
  cục đều báo cáo được: flip giảm theo k (consensus chỉ tiết kiệm ở k lớn) hoặc
  flip giữ cao (củng cố kết luận "không khuyến nghị consensus mặc định").
- Số trả về **§4.6** (một câu + một dòng bảng mỗi k), KHÔNG đụng kết luận C4.
- Chi phí: mỗi k = 4 run × 50 ca llm_assisted (k=7 đắt hơn k=5 về token/judge).
  Thời gian ước tính từ run k=3 cũ: ~vài chục phút mỗi lời gọi.

---

## O3. Infer trên Juliet (baseline tĩnh thứ hai, theo BASELINE-COMPARISON.md)

**Prereq:** Infer cài trên host chạy `compare-baselines.ts` (Linux/WSL2).
Kiểm tra `infer --version`; thiếu thì adapter tự SKIPPED (gating
`available()` trong `apps/leak-inspector-tui/src/domain/baselines/infer.ts`).

**Lệnh (mục 4 của [BASELINE-COMPARISON.md](BASELINE-COMPARISON.md), fold-in
run hệ thống nếu có metrics.json sẵn):**

```bash
pnpm exec tsx scripts/compare-baselines.ts \
  --corpus demo/juliet_cwe401 \
  --limit 30 \
  --system "no_llm=results/eval-no_llm-<ts>/metrics.json" \
  --out results/baseline-compare-infer
cat results/baseline-compare-infer/baseline-compare.md
```

(`--limit 30` giữ đúng mẫu của bảng lịch sử mục 5 để cột so sánh được; có thể
tăng sau, miễn ghi rõ mẫu số.)

**Kết quả mong đợi:** `baseline-compare.md` có thêm hàng `infer` (positive-only,
TN=0: chỉ so P/R/F1/FP/KLOC, luật mục 3). Nếu Infer báo 0 site trên Juliet mà
không có build command phù hợp, hàng vẫn in ra với sites=0; cả hai trường hợp
đều báo cáo được. Đối chiếu chéo với dải Infer tự công bố trong
[RELATED-WORK.md](RELATED-WORK.md). Số trả về **§4.7** (bảng so sánh ngoài) +
phụ lục A nếu thêm confusion matrix.

---

## O4. SARIF + demo CI/CD ~20 dòng (sketch, chưa wire)

**Bối cảnh:** hệ thống chưa có renderer SARIF (grep "sarif" trong packages/,
apps/, scripts/: 0 kết quả). Đây là bản demo-minh-họa cho mục "hướng phát triển"
(§4.11/ch5): báo cáo eval JSON biến thành SARIF 2.1.0 và upload GitHub
code scanning. Không số luận văn nào phụ thuộc mục này.

**Sketch workflow `.github/workflows/cleak-sarif.yml` (20 dòng):**

```yaml
name: cleak-sarif-demo
on: workflow_dispatch
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec tsx evaluation/cli.ts no_llm --corpus demo/juliet_cwe401 --limit 20 --yes --out-dir results/ci-scan
      - run: |
          node -e '
          const fs=require("fs");
          const m=JSON.parse(fs.readFileSync("results/ci-scan/metrics.json","utf8"));
          const sarif={version:"2.1.0",$schema:"https://json.schemastore.org/sarif-2.1.0.json",
            runs:[{tool:{driver:{name:"CLeak",rules:[{id:"CWE401"}]}},
              results:m.rows.filter(r=>r.flagged>0).map(r=>({ruleId:"CWE401",
                level:"warning",message:{text:`flagged ${r.flagged} site(s)`},
                locations:[{physicalLocation:{artifactLocation:{uri:r.id},region:{startLine:1}}}]}))}];
          fs.mkdirSync("results/sarif",{recursive:true});
          fs.writeFileSync("results/sarif/cleak.sarif",JSON.stringify(sarif,null,2));'
      - uses: github/codeql-action/upload-sarif@v3
        with: { sarif_file: results/sarif/cleak.sarif }
```

**Kết quả mong đợi:** `results/sarif/cleak.sarif` parse được JSON, có
`runs[0].results` ứng với các case bị flag; sau upload, Security tab của repo
hiện alert nguồn "CLeak". Kiểm chứng local không cần GitHub: chạy riêng bước
`node -e` trên một `metrics.json` có sẵn (ví dụ
`results/baseline-sweep-2026-08-15T08-28-06/B1/run-1/metrics.json`) rồi
`python3 -m json.tool results/sarif/cleak.sarif > /dev/null` thoát 0. Ghi chú
trung thực khi trình bày: chuyển đổi hiện map case-level (một result/case),
chưa map tới line-level finding; làm line-level là việc của renderer SARIF
thật trong packages/common nếu muốn nâng cấp.

---

## I7-residual. Benchmark wall-clock end-to-end (per-corpus + per-stage)

**Mục tiêu:** một bảng duy nhất trả lời "mỗi tầng tốn bao nhiêu", bổ sung cho
bảng operational-cost fragments đã có trong ch4 (commit `e6d0745`, I7-part).
Không cần instrumentation mới: `metrics.json` đã lưu `rows[].durationMs`,
`cost.meanDurationMs`, `cost.meanMcpCalls`, token, `costUsd` per run.

**Nguồn dữ liệu đông cứng (đọc-only):**

| Corpus | Run | metrics.json |
|---|---|---|
| Juliet full 1658 | B1 (static-only, 0 token) | `results/baseline-sweep-2026-08-15T08-28-06/B1/run-1/metrics.json` |
| Juliet full 1658 | B2 (dynamic-only) | `.../B2/run-1/metrics.json` |
| Juliet full 1658 | B4 (LLM + static) | `.../B4/run-1/metrics.json` |
| Juliet full 1658 | B6a (headline) | `.../B6a/run-1/metrics.json` |
| LAMeD 41 | llm_assisted ×3 | `results/lamed-llm_assisted-2026-08-20/run-1/metrics.json` |
| MemHint 19 | (sau Giai đoạn 1) | `results/eval-*memhint*/metrics.json` |

**Lệnh trích số:**

```bash
python3 - <<'PY'
import json, glob
def cost(p):
    m=json.load(open(p)); c=m['cost']
    return dict(cases=c['cases'], ms_case=c['meanDurationMs'],
                mcp=c.get('meanMcpCalls'), tok=c.get('meanTokens'),
                usd_case=(c['costUsd']/c['cases'] if c.get('costUsd') else None))
paths = {
 'Juliet B1':  'results/baseline-sweep-2026-08-15T08-28-06/B1/run-1/metrics.json',
 'Juliet B2':  'results/baseline-sweep-2026-08-15T08-28-06/B2/run-1/metrics.json',
 'Juliet B4':  'results/baseline-sweep-2026-08-15T08-28-06/B4/run-1/metrics.json',
 'Juliet B6a': 'results/baseline-sweep-2026-08-15T08-28-06/B6a/run-1/metrics.json',
 'LAMeD llm':  'results/lamed-llm_assisted-2026-08-20/run-1/metrics.json',
}
for k,p in paths.items():
    print(k, cost(p))
PY
```

**Phân rã per-stage (quy ước ghi rõ cạnh bảng):**

- Static evidence/case ≈ `meanDurationMs` của B1 (không LLM, không dynamic).
- Dynamic/case ≈ `meanDurationMs` của B2.
- Judge + orchestration/case ≈ B6a − B1 (gồm LLM turn + enrich; sai số chấp
  nhận được vì static recipe giữa hai cấu hình giống nhau ở mức recipe).
- LAMeD/MemHint báo end-to-end + $/case; cột stage để "n/a" nếu chưa có cặp
  B1/B2 tương ứng trên corpus đó.
- Tinh chỉnh tùy chọn: bấm giờ 2 MCP call sanitizer trực tiếp trên 1 case bằng
  `curl` + JSON-RPC (ví dụ sẵn trong docs/MCP-TOOLS.md) để tách build vs run.

**Kết quả mong đợi: MỘT bảng** dạng:

| Corpus / cấu hình | static/case (s) | dynamic/case (s) | judge+orch/case (s) | tổng/case (s) | $/case |
|---|---|---|---|---|---|
| Juliet 1658, B1 | … | n/a | n/a | … | 0 |
| Juliet 1658, B6a | … | … | … | … | … |
| LAMeD 41, llm ×3 | n/a | n/a | n/a | … | … |
| MemHint 19, llm | … | … | … | … | … |

Số tham chiếu để tự kiểm khi điền (đã đo trên đĩa): B6a run-1
`meanDurationMs = 22457` (~22.5 s/case), `meanMcpCalls = 10`,
`costUsd = 2.2154` trên 1658 ca. Bảng trả về **§4.10** cạnh bảng cost fragments
hiện có; ghi chú mẫu số (giây trung bình trên case chạy-ok, wall-clock gồm cả
chờ MCP).
