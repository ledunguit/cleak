# LAMeD re-score runbook — công cụ-độc lập trên mẫu số /41 (Finding C.1, I2)

> **Trạng thái: PREPARED, CHƯA CHẠY.** Worker chuẩn bị dữ liệu + quy trình; tác giả
> luận văn **phê duyệt luật quy-gán** (mục 1) rồi mới chạy các lệnh (mục 2). Số /41
> CHƯA được đưa vào `paper/chapters/chapter4-evaluation.md` (§4.5/§4.7.2) — chỉ sau
> khi author approve và re-score chạy xong.

## Bối cảnh

Vết attack dễ bị đánh nhất về phương pháp luận của luận văn hiện nay là mẫu số
của scorer LAMeD: CLeak được chấm trên 50 site, Clang trên 43 — hai hàng của
Bảng 4.8 không cùng mẫu số, "by design của scorer" (§4.5.1,
`results/lamed-correction-2026-08-20-README.md` mục 4). Đáp án chi phí-gần-bằng-0:
LAMeD công bố **41 leak xác nhận** (7 dự án) — chính là 41 case của corpus
(`demo/lamed/corpus_manifest.json`, validation `41/41 clean`, content-hash
`bf728e94c821b34b7c6b76dd8b2532ca`). Chấm lại **mọi tool trên cùng mẫu số /41**
biến 43-vs-50 từ "hai mẫu số không so sánh được" thành "cùng một mẫu số công bố,
tool nào cũng được quy-gán về đó". Chương 3 (§3.9) đã báo recall theo mẫu số này
("0/41 lên 12/41"), nên /41 không phải mẫu số mới chế ra — nó là mẫu số LAMeD
đã công bố và luận văn đã dùng.

Dữ liệu ground-truth: [`docs/data/lamed41_sites.json`](data/lamed41_sites.json)
(41 entry, mỗi leak một entry, kèm `attribution_rule` riêng cho từng ca,
`fix_commit`, allocators/deallocators của dự án — copy nguyên vẹn từ manifest).

## 1. Luật quy-gán tường minh (author phải duyệt trước khi chạy)

**Đơn vị mẫu số:** một leak công bố = một case corpus = **một** đơn vị /41, bất
kể leak đó trải bao nhiêu flaw site hay bao nhiêu site chấm được của tool.

**Leak nào tính là "bắt được":** production scorer (`scoreCase`,
`apps/leak-inspector-tui/src/domain/evalScoring.ts`) đã xuất per-site samples cho
mọi run (file `cases/<caseId>.json`, `samples[]`, `siteId = "<caseId>::<site>"`).
Quy-gán là **chỉ regroup lại chính output đó**, không đổi matcher:

- **Luật chính (variant A — khuyến nghị):** leak được tính bắt được ⇔ case đó có
  ít nhất một sample `actual=true, predicted=true`. Đây là regroup trung thành
  của cùng một run đã sinh 15/50 — cùng scorer, cùng semantics, chỉ đổi mẫu số.
- **Luật nhạy (variant C — sensitivity, nên báo kèm):** như A nhưng loại
  fallback đặt tên của Juliet (`contains('good')/contains('bad')` trong
  `classifyFunction`) — heuristic chỉ hợp lệ trên corpus Juliet, không có nghĩa
  trên dự án thật. Lý do phải loại bỏ khi đo độ nhạy: hàm
  `solv_replacebadutf8` (nghĩa là "replace **bad** utf8", nằm ở `util.c`) đã bị
  fallback này xếp thành flaw-function, sinh ra **3 trong 13 detections của A**
  (các ca libsolv `062c0`, `98a75`, `1f29f7` — ca 062c0 và 98a75 chỉ được gán
  file, không có function). Nếu bỏ artifact này, A còn **10/41**.
- **Multi-site leak:** đếm **một lần** dù nhiều site của cùng leak được flag
  (ví dụ libtiff `04118` có 2 flaw function `main` + `map_colortable`). Chính vì
  thế **không kỳ vọng 15/41**: 15 là số *site*, trong đó 2 site là detect trùng
  của leak đã đếm (9a361f và 71c6b2, cùng do `solv_replacebadutf8`) → kỳ vọng
  A là **13/41**, C là **10/41** (đã đo offline, xem mục 4).
- **6 ca chỉ có annotation mức file** (không có flaw function trong manifest:
  libtiff `462f1f`, libsolv `062c0`, `98a75`, cjson `58bc38`, curl `95d304`,
  libssh2 `8abc68`): không thể quy-gán bằng function-match tường minh → auto-FN
  dưới luật C, và dưới luật A chỉ dính_detect qua fallback. Trầnrecall dưới C vì
  thế là 35/41. Đây là hạn chế của ground truth, không phải của tool — và là
  lý do trực tiếp cho tuỳ chọn mở rộng (mục 3).
- **Precision không định nghĩa trên /41** (corpus positive-only, `positive_only:
  true` — flag ngoài site đã gán không phải bằng chứng FP; đã xử lý ở
  `extraFindings`). Chỉ báo recall = detected/41, đúng cách LAMeD tự báo cáo.

**Khuyến nghị chốt số vào luận văn:** bảng chính dùng **A (13/41)** — cùng
scorer với cột 15/50 nên không bị buộc tội đổi luật giữa các cột; báo **C
(10/41)** một dòng sensitivity kèm tên artifact `solv_replacebadutf8`. Cần biết:
artifact fallback cũng nằm trong chính 15/50 hiện tại (2 predicted sites ở ca
062c0/98a75), nên A-vs-/50 vẫn so sánh được apples-to-apples.

## 2. Lệnh re-score (copy-paste được; chạy từ repo root)

Yêu cầu chung: analyzer services đang chạy (`docker compose up --build`;
dynamic + scan-build cần Linux/Docker — macOS chạy qua container). Node 22
(`nvm use 22`), pnpm. `<DATE>` = ngày chạy, ví dụ `2026-09-21`.

### 2.1. CLeak `no_llm` (mặc định + biến thể interproceduralFlow)

```bash
pnpm exec tsx scripts/evaluate-corpus.ts no_llm --corpus demo/lamed --dynamic selective \
  --out-dir results/lamed-no_llm-default-<DATE>
pnpm exec tsx scripts/evaluate-corpus.ts no_llm --corpus demo/lamed --dynamic selective \
  --static-tools candidateScan,functionSummary,pathConstraints,interproceduralFlow \
  --out-dir results/lamed-no_llm-ipf-<DATE>
```

Kết quả mong đợi: hai run **byte-identical** với nhau ở phần findings (chỉ khác
timestamp/scanId — đã root-cause trong correction README mục 2), TP-sites = 15,
FP = 0 như Bảng 4.8.

### 2.2. CLeak B6a (planner + pinned recipe + LLM judge)

```bash
pnpm exec tsx evaluation/cli.ts --corpus demo/lamed --baseline B6a \
  --out-dir results/lamed-b6a-lamed-<DATE>
```

- Config của B6a nằm ở `configs/baselines/b6a-planner-only.yaml` (`runs: 3`,
  `consensusN: 1`, planner + fusion bật). Per-case output:
  `results/lamed-b6a-lamed-<DATE>/B6a/cases/*.json`.
- **Cần LLM provider đã cấu hình** (`~/.config/cleak/config.json`; bộ run chốt
  của luận văn dùng `deepseek-v4-flash`, xem §4 mở đầu) — bước này TỐN token;
  chạy sau khi author duyệt, không phải bước dry-run.
- Hiện chưa có artifact LAMeD cho B6a trên đĩa (sweep 9b 2026-08-19 chỉ kịp B1),
  nên không có số /41 B6a để đối chiếu trước.

### 2.3. Clang Static Analyzer

```bash
pnpm exec tsx scripts/compare-baselines.ts --corpus demo/lamed --out results/lamed-baseline-<DATE>
```

Lưu ý: script này chỉ persist bảng tổng hợp (baseline-compare.csv/json/md), KHÔNG
persist per-case samples — mà /41 cần samples. Chạy thêm một lần dump nhỏ:

```bash
cat > "$TMPDIR/clang-samples.mts" <<'EOF'
import { writeFileSync, mkdirSync } from 'node:fs';
import { ClangAnalyzerAdapter } from '/Users/zed/Master/cleak/apps/leak-inspector-tui/src/domain/baselines/clangAnalyzer';
import { runBaselineEval } from '/Users/zed/Master/cleak/apps/leak-inspector-tui/src/domain/baselines/runBaselineEval';
const res = await runBaselineEval(new ClangAnalyzerAdapter(), 'demo/lamed', {});
mkdirSync('/Users/zed/Master/cleak/results/lamed-baseline-clang-samples', { recursive: true });
writeFileSync('/Users/zed/Master/cleak/results/lamed-baseline-clang-samples/samples.json',
  JSON.stringify(res.samples, null, 1));
console.log('samples:', res.samples.length, '| tp:', res.overall.tp);
EOF
pnpm exec tsx "$TMPDIR/clang-samples.mts"
```

(Sửa 2 đường dẫn `/Users/zed/Master/cleak` nếu repo ở chỗ khác. Cần
clang-analyzer/scan-build available — trên máy dev macOS hãy chạy trong container
static-analyzer, giống bộ run 2026-08-20.)

### 2.4. Chấm /41 (offline, không Docker, không LLM — chạy được ngay sau 2.1–2.3)

```bash
cat > "$TMPDIR/lamed41-rescore.py" <<'EOF'
#!/usr/bin/env python3
"""LAMeD /41 re-score: regroup production scoreCase output to leak granularity.
Usage: python3 lamed41-rescore.py <run-cases-dir> [<run-cases-dir> ...]
Variant A: faithful regroup (sample actual=true & predicted=true).
Variant C: explicit flaw-function match, Juliet naming fallback excluded.
"""
import json, os, sys

ROOT = '/Users/zed/Master/cleak'
GT = json.load(open(f'{ROOT}/docs/data/lamed41_sites.json'))
CASES = {l['id']: l for l in GT['leaks']}
FLAGGED = {'leak', 'likely_leak', 'vulnerable'}

def norm(s): return (s or '').strip().lower()

def same_function(a, b):  # production sameFunction, không fallback
    x, y = norm(a), norm(b)
    if not x or not y: return False
    if x == y: return True
    for lo, sh in ((x, y), (y, x)):
        if len(lo) > len(sh) and lo.endswith(sh) and lo[len(lo) - len(sh) - 1] in '_:.':
            return True
    return False

def variant_c(case, findings):
    fns = [fs['function'] for fs in case['flaw_sites'] if fs['function']]
    return any(f.get('verdict') in FLAGGED
               and any(same_function(f.get('function', ''), fn) for fn in fns)
               for f in findings)

for d in sys.argv[1:]:
    detA, detC = [], []
    for cid in CASES:
        j = json.load(open(os.path.join(d, f'{cid}.json')))
        if any(s.get('actual') and s.get('predicted') for s in j.get('samples') or []):
            detA.append(cid)
        if variant_c(CASES[cid], j.get('findings') or []):
            detC.append(cid)
    print(f'{d}\n  A (faithful regroup): {len(detA)}/41  R={len(detA)/41:.3f}'
          f'\n  C (no naming fallback): {len(detC)}/41  R={len(detC)/41:.3f}')
    if len(detA) != len(detC):
        print('  A-only (fallback-riding):', sorted(set(detA) - set(detC)))
EOF
python3 "$TMPDIR/lamed41-rescore.py" results/lamed-no_llm-default-<DATE>/cases \
  results/lamed-b6a-lamed-<DATE>/B6a/cases
```

Với Clang (chỉ có samples, không có findings — nhưng TP=0 nên A≡C):

```bash
python3 - <<'EOF'
import json
s = json.load(open('results/lamed-baseline-clang-samples/samples.json'))
det = sorted({x['siteId'].split('::')[0] for x in s if x.get('actual') and x.get('predicted')})
print(f'Clang /41 (variant A): {len(det)}/41  R={len(det)/41:.3f}')
print('detected:', det)
EOF
```

### 2.5. Regression check bắt buộc (không tốn gì — artifacts 2026-08-20 đã trên đĩa)

```bash
python3 "$TMPDIR/lamed41-rescore.py" results/lamed-no_llm-default-2026-08-20/cases \
  results/lamed-no_llm-ipf-2026-08-20/cases \
  results/lamed-llm_assisted-2026-08-20/run-1/cases \
  results/lamed-llm_assisted-2026-08-20/run-2/cases \
  results/lamed-llm_assisted-2026-08-20/run-3/cases
```

Mong đợi: cả 5 run đều **A = 13/41 (R 0.317), C = 10/41 (R 0.244)** — đã xác nhận
bằng dry-run offline (evidence:
`.omo/evidence/review-remediation/task-14/dry-run.txt`). Nếu script (cùng phiên
bản luật) cho số khác trên artifacts đóng băng này → luật quy-gán bị hỏng, dừng
lại sửa trước khi tin số fresh-run.

## 3. Tuỳ chọn mở rộng: mẫu số union-site (fix đầy đủ, chi phí cao hơn)

/41 là bước đầu chi phí-gần-bằng-0; đáp án trọn vẹn cho Review Q12 ("recompute
LAMeD on a union-site denominator") là chấm trên **tập site hợp (union)**:

1. Clone 7 dự án ở đúng commit (URL `bugRepoLink` → `fixCommit` đã lưu trong
   `docs/data/lamed41_sites.json`).
2. Trích diff hunk của từng fix-commit, lấy các dòng alloc/free bị sửa đổi, map
   về enclosing function → **line-level ground truth** cho 41 leak (43 flaw site
   hiện có chỉ là file+function).
3. Mẫu số := hợp của (i) 43 flaw site manifest, (ii) các alloc-site từ fix-commit
   diff, (iii) các finding của tool được adjudicate thủ công là leak thật chưa
   catalogue (xử lý 26 extra findings hiện bị loại khỏi P/R — đúng chính sách
   `positive_only`, nhưng union biến "không chấm" thành "chấm có quyết định người").
4. Chấm mọi tool trên CÙNG tập đó với cùng matcher (`sameFunction` + line-match
   ở line mode). 6 ca chỉ-annotation-mục-file lúc này trở nên chấm được.

Chi phí ước tính: một buổi đọc 41 diff nhỏ (mỗi commit là một leak đã được LAMeD
xác nhận) + adjudicate findings. Khi có union denominator, cột /41 (mục 2) vẫn
giữ giá trị như số báo-cáo-được-lặp-lại độc lập với UnionSet (mẫu số LAMeD công bố).

## 4. Acceptance criteria (author đối chiếu sau khi chạy)

| Hạng mục | Kỳ vọng | Nếu lệch |
|---|---|---|
| Gate JSON | `node -e "const j=require('./docs/data/lamed41_sites.json'); console.log(j.leaks.length)"` in `41`; mọi entry có `attribution_rule` khác rỗng | Sửa JSON, không sửa luật |
| Runbook | chứa đủ 4 mục (grep: "luật quy-gán", "union", "Clang", "15/41") | — |
| Regression check 2.5 (artifacts đóng băng 2026-08-20) | A = **13/41** (R 0.317), C = **10/41** (R 0.244), cả 5 run identical | Luật quy-gán/matcher lệch — dừng, audit |
| CLeak no_llm + ipf + llm_assisted (fresh) | Ba cấu hình confusion matrix giống hệt nhau (variance = 0, như §4.5.1); A trong dải **10–15/41** (kỳ vọng điểm 13; §3.9 báo 12/41 trên trajectory; trần 15 vì 15 là số site) | ngoài dải ⇒ lỗi quy-gán: đối chiếu detected-ids với dry-run |
| B6a | Chưa có số đối chiếu; chấp nhận mọi giá trị lần đầu, ghi lại kèm judge-path telemetry | — |
| Clang | **0/41** (bắt buộc — scoring riêng của Clang đã TP=0 trên 43 site; ≠0 ⇒ quy-gán gán nhầm) | Audit matcher |

Kết quả lần đầu chạy được ghi vào runbook mục này (điền vào bảng) trước khi chỉnh
sửa `paper/chapters/chapter4-evaluation.md` §4.5/§4.7.2 — số /41 chỉ vào luận văn
sau khi author duyệt luật + số đo khớp dải kỳ vọng.

## 5. Đã làm / chưa làm (worker, 2026-09-21)

- ĐÃ: dựng `docs/data/lamed41_sites.json` từ `demo/lamed/corpus_manifest.json`
  (nguồn tốt nhất có local; `cJSON-annotated.csv` là annotation AllocSource/
  FreeSink mức-function của cJSON, không phải danh sách leak — chỉ dùng chéo để
  đối chiếu allocator); dry-run offline mọi run trên đĩa (không Docker/LLM),
  log tại `.omo/evidence/review-remediation/task-14/dry-run.txt`.
- CHƯA (cần author/Docker/LLM): chạy 2.1–2.3 fresh, Clang /41 thật, B6a LAMeD
  (chưa từng có artifact), và mọi sửa số trong chapter 4.
