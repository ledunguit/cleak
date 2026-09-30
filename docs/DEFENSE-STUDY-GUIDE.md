# Study Guide bảo vệ — Hệ thống, phép đo & bộ số liệu

> **Mục đích.** Tài liệu tự học đi kèm [DEFENSE-PLAN.md](DEFENSE-PLAN.md): (1) hệ thống
> trong một trang, (2) ý nghĩa từng phép đo, (3) bộ số liệu neo artifact theo đúng tập,
> (4) bản đồ claim → bằng chứng, (5) câu hỏi tự kiểm.
>
> **Quy tắc vàng:** *một câu trả lời trước hội đồng = MỘT tập số từ MỘT nguồn.* Không
> bao giờ trộn số paper với số artifact khác thế hệ trong cùng một câu.

---

## 1. Hệ thống trong một trang

### Nguyên tắc trung tâm
**"LLM owns policy, the engine owns mechanism."** — LLM quyết định *cái gì cần điều tra*
(chính sách), engine quyết định *cách thực thi* (cơ chế). Mọi stage tất định trừ judge;
chỉ bundle borderline mới được escalate lên LLM.

### Thành phần
| Thành phần | Vai trò |
|---|---|
| `leak-inspector-tui` + `agent-core` | Orchestrator duy nhất — vòng lặp native tool-calling |
| `static-analyzer` (MCP/HTTP :50061) | Tree-sitter AST, call graph, ownership, scan-build — 11 tools |
| `dynamic-analyzer` (MCP/HTTP :50062) | Valgrind, ASan/LSan, build sanitizer — 11 tools |
| `packages/common` | Heuristic / single-LLM / consensus judge, scorer, reporting |

Tổng **22 MCP tools**; chỉ **5 content-capable tools** chạm tới LLM sub-agent Stage A:
`candidateScan`, `astScan`, `functionSummary`, `pathConstraints`, `ownershipConventions`
(cộng `read_file`) — các tool này nhận source content inline nên service giữ stateless.

### Pipeline 4 stage (Stages A–D)
| Stage | Việc | LLM tham gia? |
|---|---|---|
| **A — Static fan-out** | Candidate từ `candidateScan` trên **frozen allocator profile**; group theo file affinity thành batch, mỗi batch một LLM sub-agent thu thập bằng chứng cấu trúc. Sub-agent **không được phép ghi verdict** — bằng chứng được capture bằng code bọc quanh mỗi tool call, không do model tự báo (chặn hallucination trên đường đánh giá) | Có (sub-agent, chỉ thu evidence) |
| **B — Dynamic evidence** | Ca có build command đã biết (như Juliet) → **pinned recipe**: `buildTarget` (sanitizer flags) → `lsanRun`, **không một lời gọi LLM** (đóng góp C1 — đây là chỗ làm dynamic evidence tái lập bit-for-bit). Chỉ khi KHÔNG có build command thì LLM dynamic worker mới tiếp quản | Không (recipe) / Có (fallback worker) |
| **C — Synthesis** | Hợp nhất bằng chứng thành leak bundles — **LLM-free** | Không |
| **D — Hybrid judging** | Heuristic judge chạy cho **TẤT CẢ** bundles (path-aware nhờ enrichment — C3); LLM judge chỉ cho **borderline**; consensus (K>1) là opt-in | Có (chỉ borderline) |

Cấu hình `no_llm` = **0 lời gọi LLM** toàn pipeline.

### Ba POLICY module (nơi LLM được ra quyết định, đều có verification)
Allocator profiler (khám phá allocator/deallocator của dự án + grep verification, freeze
vào cache profile) · Strategist · Judge tuner.

### Hai tầng tái lập (two-tier, C2)
- **Tier-1 `no_llm` (B1–B3):** tất định bit-for-bit, được CI gate bảo vệ
  (`scripts/determinism-gate.sh`) — gate từ chối 2 mode "đậu giả" từng gặp: self-comparison
  do trùng timestamp, và run lỗi-toàn-phần ngụy trang thành "tất định".
- **Tier-2 `llm_assisted` (B4–B7):** không thể tất định bitwise — ngay cả temperature 0 vẫn
  còn non-determinism từ phía provider (batching/scheduling) — nên báo cáo **phân phối**
  (mean ± std qua 3 runs, std ≤ 0.007 trên F1) + verdict-flip rate, thay vì giấu dao động.

---

## 2. Phép đo & ý nghĩa

### Site & site-based scoring
- **Site** = một vị trí hàm được gán nhãn trong corpus manifest (`flaws[]` = leak thật,
  `clean[]` = không leak). **Mọi cấu hình được chấm trên CÙNG một universe site cố định**
  với đủ 4 ô TP/FN/FP/TN — không ai được chấm trên universe riêng.
- Paper (Juliet): **10.314 site = 2.557 bad + 7.757 good** (từ 1.658 ca; 324 merge group
  gộp nhãn trùng). Flag ngoài universe được ĐẾM nhưng KHÔNG CHẤM (B1: 66).
- *Ý nghĩa:* mọi so sánh baseline là tương đối công bằng — cùng thước đo, cùng mệnh số.

### Precision / Recall / F1
- **Precision = TP/(TP+FP)** — trong số hệ flag, bao nhiêu là leak thật. Cao = ít false
  alarm = chi phí xác minh mỗi cảnh báo thấp.
- **Recall = TP/(TP+FN)** — trong số leak thật, hệ bắt được bao nhiêu. Cao = ít bỏ sót.
- **F1** = trung bình điều hòa P và R. Tổng hợp một số duy nhất, nhạy với mất cân bằng lớp.
- *Đọc số B6a (paper): P 96,5% / R 78,6%* — cứ 100 cảnh báo, ~96,5 leak thật; bắt được
  78,6% tổng số leak đã gán nhãn.

### MCC (Matthews Correlation Coefficient)
`MCC = (TP·TN − FP·FN) / √((TP+FP)(TP+FN)(TN+FP)(TN+FN))`, khoảng [−1, +1], 0 ≈ đoán ngẫu nhiên.
- *Vì sao báo cáo cùng F1:* F1 bỏ qua TN; với universe lệch lớp (7.757 good vs 2.557 bad)
  MCC dùng đủ 4 ô, phản ánh trung thực hơn. B6a: **F1 0,867 / MCC 0,836** — cả hai cao,
  không phải hiện tượng F1 đẹp nhờ bỏ qua TN.

### McNemar paired test (có hiệu chỉnh Edwards)
- **Định nghĩa:** kiểm định trên các **cặp site ghép theo `siteId`** — chỉ nhìn các cặp
  HAI cấu hình KHÔNG đồng thuận: `b01` (A sai/B đúng), `b10` (A đúng/B sai).
  `χ² = (|b10 − b01| − 1)² / (b10 + b01)`.
- **Ý nghĩa:** trả lời "khác biệt F1 giữa hai cấu hình có phải nhiễu aggregate không?"
  p < α → khác biệt có ý nghĩa thống kê.
- **Bốn phép đã có sẵn (artifact thật):**
  | Cặp so | n | b01/b10 (bất đồng) | χ² | p | Kết luận |
  |---|---|---|---|---|---|
  | B6a vs B1 | 6.037 | 51 / 1.236 (≈24:1) | 1.089,2432 | **7,192e−239** | B6a tốt hơn B1 có ý nghĩa — LLM có đóng góp đo được |
  | B6 vs B6a | 6.042 | 73 / 66 | 0,2590 | **0,611** | KHÔNG khác biệt — B6a được chọn vì lý do vận hành (planner-status/coverage), không phải F1 |
  | Consensus, campaign A (paper §5.4) | 267 | 7/8 bất đồng nghiêng single | 3,13 | **0,077** | Chưa có ý nghĩa ở α=0,05 — chỉ 8 cặp bất đồng, thiếu sức thống kê |
  | Consensus, campaign B (paper §5.4) | 273 | 6/6 nghiêng single | 4,17 | **0,041** | Có ý nghĩa; cùng HƯỚNG với A → chỉ claim sign, không claim effect size |
- Tool: `scripts/mcnemar-compare.ts`; log kiểm định:
  `.omo/evidence/review-remediation/task-8/mcnemar-{b6avs-b1,b6-vs-b6a}.txt`.
- **Bản chất (phải thuộc):** chỉ các cặp **BẤT ĐỒNG** (một đúng một sai) mang thông tin —
  cặp cả-hai-đúng/cả-hai-sai bị vứt bỏ. H₀ = bất đồng đối xứng 50/50 như đồng xu công bằng.
  χ² đo độ lệch khỏi chia đều; p = xác suất thấy độ lệch cỡ này nếu hai hệ ngang nhau.
  **Đo được:** hướng + độ chắc chắn. **KHÔNG đo được:** độ lớn khác biệt, hành vi theo
  family, chất lượng tuyệt đối. → p cực nhỏ ≠ "tốt hơn gấp nhiều"; độ lớn nhìn qua F1 gap.

### Verdict-flip rate & modal agreement
- **Flip rate** = tỉ lệ ca mà verdict ĐỔI giữa các lần chạy lặp lại cùng cấu hình — đo
  **độ ổn định** của LLM judge, không phải độ chính xác.
- **Modal agreement** = tỉ lệ ca mà verdict theo bầu đa số (modal) giữa các run.

### std = 0 trên corpus thực (null result có ý nghĩa)
Trên LAMeD và MemHint, `llm_assisted` (3 runs) cho confusion matrix **y hệt** `no_llm`:
LLM được gọi 47–149 lần/run nhưng **không lật verdict nào** (MemHint: LLM chỉ can thiệp
2/~17,1k verdict flagged, trong 1/3 run, 0 lật). *Ý nghĩa:* trên corpus thực, lớp judging
LLM hiếm khi thay đổi kết quả — nhất quán trên hai corpus độc lập, củng cố kết luận RQ1.

### Stratified vs full-corpus (vì sao hai con số khác nhau)
- **Stratified n=50:** lấy mẫu ĐỀU 10 family → con số phản ánh "năng lực trên mỗi family
  như nhau" — cao hơn (B6a F1 0.938 ở thế hệ sweep).
- **Full-corpus 1.658 ca:** theo đúng tỉ lệ corpus (skew — `new`/`delete` 588/1658) —
  thấp hơn, và **đây là số headline của paper** vì đại diện toàn cảnh.
- *Câu trả lời "trung bình đẹp":* số tổng đã BAO GỒM family yếu; bảng per-family công bố
  đầy đủ (paper: malloc 0.975 → strdup 0.584) — không che giấu gì.

### Positive-only convention (LAMeD, MemHint)
- Corpus chỉ có nhãn DƯƠNG (leak confirmed). **Recall đo bình thường** (có ground-truth
  dương). **Precision đo theo quy ước bảo thủ:** flag nào KHÔNG thuộc tập confirmed →
  ĐẾM LÀ FP (dù có thể là leak thật chưa confirm — vẫn tính ngược lại hệ).
- **Denominator mỗi hệ = finding-granularity của chính nó** (paper LAMeD 43 site vs bộ
  artifact khác 50 site) — by design của scorer, không phải chọn số đẹp.

### Corpus gate (content-hash)
Mọi corpus phải qua `checkCorpusGate()`: lockfile `*.lock.json` ghi content-hash từng file
source, kiểm tra lúc chạy. *Nguồn gốc:* corpus cũ có 422/1.984 ca C++ không build được,
bị loại âm thầm khỏi confusion matrix → toàn bộ số thế hệ đó đã bỏ, thay bằng corpus
validated 1.658 ca, hash `f578c3ee…`, 0 quarantined.

### Family slice
F1 tính riêng theo family allocator (malloc/strdup/new/…) — công cụ chẩn đoán điểm yếu,
được công bố chứ không giấu sau số tổng.

---

## 3. Bộ số liệu — BA TẬP, KHÔNG TRỘN

### TẬP P — Paper `conference/main.pdf` (bản hội đồng đọc; universe 10.314 site cố định)
| Số | Giá trị | Ý nghĩa / claim |
|---|---|---|
| `no_llm` tier | **F1 0,614 / MCC 0,507** | Mốc đáy tất định — điểm so sánh cho mọi cấu hình LLM |
| **B6a** (pinned recipe + planner 1 call/ca + borderline judge) | **P 96,5% · R 78,6% · F1 0,867 · MCC 0,836** | Cấu hình mạnh nhất đo được — đóng góp C1 |
| Chi phí | B6a ≈ **1/4** chi phí agentic; B6b/B7 **~4×** cho F1 **thấp hơn** | Giá trị nằm ở LLM CÓ KIỂM SOÁT, không phải LLM nhiều |
| Family slice | malloc **0,975** / strdup **0,584** | Family variance công khai |
| **LAMeD** (43 site, positive-only) | **TP 10 / FP 0 / FN 33 → P 100% · R 23,3%**; `llm_assisted` y hệt, std=0 (3 runs) | Mọi cảnh báo đều đúng trên dự án thực; LAMeD tự báo SOTA chỉ bắt 5–10/43 |
| **MemHint reconstructed** (19 ca / 6 dự án, positive-only) | **8/19 → P 100% · R 42,1%**; `llm_assisted` P 1.000/R 0.421/F1 **0,593 ± 0.000** | Null result nhất quán trên corpus thực thứ hai |
| **Consensus n=50 stratified** | single ổn định hơn: flip **2,0% vs 8,0%**; chính xác hơn: F1 **0,852–0,855 vs 0,793–0,796**; McNemar camp. A 7/8 bất đồng (p=0,077, ns) — camp. B 6/6 (p=0,041, sig) | Không khuyến nghị consensus mặc định (C4); chỉ claim sign-reversal, không claim effect size |
| Clang SA (§5.6, cùng 10.314 site) | Static stage thắng F1 qua recall (**~2,2×** nhiều leak hơn); Clang chỉ thắng precision trên tập flag nhỏ | So sánh ngoài cùng scorer, cùng universe |

### TẬP S — Sweep artifact `results/baseline-sweep-2026-08-15T08-28-06/` (case-based, commit `5eec8b1`, deepseek-v4-flash)
| Số | Giá trị |
|---|---|
| B6a full 1.658 ca | **F1 0,863 ± 0,001 / MCC 0,790 · $6,63** |
| B1 static-only | **F1 0,612** |
| Stratified n=50 | B6a **0,938** (P 0,973/R 0,906) · B1 0,792 · B3 rule-ensemble 0,857 · B6b/B7 0,929 (~9× token) |
| McNemar B6a–B1 | n=6.037, b01=51/b10=1.236, χ²=1.089,2432, **p=7,192e−239** |
| McNemar B6–B6a | n=6.042, b01=73/b10=66, χ²=0,2590, **p=0,611** |

> ⚠️ **Cấm tuyệt đối:** dùng cặp **"0.776 vs 0.612"** — run 0.776 sinh 2026-08-11, TRƯỚC
> chuỗi fix reference-out-param/virtual-dispatch/RAII 2026-08-12 → so lệch thế hệ code.
> Run 0.776 chỉ dùng làm dữ liệu chi phí/judge-path, phải ghi rõ commit.

### TẬP C — Consensus & corpus thực (thế hệ artifact docs; trích khi nói về LỊCH SỬ phát hiện)
| Thí nghiệm | Kết quả |
|---|---|
| n=30 top-N (06/2026) | Vô tình 100% một family; consensus thắng: flip 13,3–26,7% → 6,7% |
| n=50 stratified (19/08/2026) | **ĐẢO DẤU (SIGN-REVERSAL):** single thắng; **McNemar p=0,077**; nhất quán 2 campaign độc lập |
| LAMeD artifact 20/08/2026 | 15 TP / 50 site, R 30%, FP=0, std=0; `interproceduralFlow` Δ=0 (root cause: path-insensitivity trong tool) |
| MemHint artifact (docs) | TP 12 / FP 0 / FN 14, R 46,2%, F1 0,632 ± 0.000 |

> ⚠️ **Lệch số TẬP P ↔ TẬP C trên corpus thực:** LAMeD paper = 10 TP/43 site (23,3%) nhưng
> artifact 08/2026 = 15 TP/50 site (30%); MemHint paper = 8/19 (42,1%) nhưng docs = 12/19
> (46,2%). Paper là bản kể chuyện mới nhất (rescoring trên universe site cố định).
> **Trước hội đồng: nói theo TẬP P khi đối chiếu paper; nếu trích TẬP C phải gọi tên
> artifact + ngày. Nếu quyển luận văn còn giữ số TẬP C → cần đồng bộ.**

---

## 4. Bản đồ claim → bằng chứng

| Claim | Bằng chứng (tập nào) |
|---|---|
| **C1** — Pinned-recipe hybrid mạnh nhất, rẻ | Tập P: 0.867/0.836 vs 0.614; 4× chi phí agentic cho F1 thấp hơn |
| **C2** — Giao thức tái lập hai tầng đo được | Tier-1 bitwise + gate chống 2 false-pass; Tier-2 std ≤ 0.007 (Table 4), flip rate công bố |
| **C3** — Enrichment làm judge tất định path-aware không SMT | Ownership-transfer, alloc→free + guard-subset, feasible-leak-path; phát hiện trung thực `interproceduralFlow` Δ=0 |
| **C4** — Consensus: sign-reversal, không khuyến nghị | Tập C: n=30 thắng → n=50 stratified thua; p=0,077 — không claim effect size |
| LLM có đóng góp thật | Tập S: McNemar B6a–B1 p=7,2e−239 |
| Chọn B6a (không phải B6) | Tập S: p=0,611 → tương đương thống kê; chọn vì planner-status/coverage (vận hành) |

---

## 5. Câu hỏi tự kiểm (che phần đáp án)

1. **Precision đo sao trên corpus positive-only?**
   → Recall đo bình thường (có ground-truth dương). Precision theo quy ước bảo thủ:
   flag ∉ tập confirmed → đếm FP. Không được nói ngược "recall không đo được negative".
2. **Vì sao báo cáo cả F1 lẫn MCC?**
   → Universe lệch lớp (7.757 vs 2.557); F1 bỏ qua TN, MCC dùng đủ 4 ô.
3. **10.314 site từ đâu ra?**
   → 1.658 ca validated → 2.557 bad + 7.757 good (324 merge group); mọi config chấm trên
   cùng universe; flag ngoài universe đếm-không-chấm.
4. **"+0.001 F1 của B6 so với B6a — chọn B6a dựa trên gì?"**
   → p=0,611: tương đương thống kê. Chọn B6a vì planner-status/coverage cho dynamic
   fallback — giá trị vận hành, không phải F1.
5. **"p=7,2e−239 nói được gì, KHÔNG nói được gì?"**
   → Nói được: khác biệt B6a–B1 có ý nghĩa thống kê trên paired sites. Không nói được:
   độ lớn tác động trên mỗi family, hay bất kỳ gì ngoài cặp cấu hình đó.
6. **"Flip 2% vs 8% — được phép claim gì?"**
   → Chỉ claim SIGN-REVERSAL khi đổi scheme lấy mẫu + hai campaign: A (7/8 bất đồng,
   p=0,077 — chưa đủ ý nghĩa, low power), B (6/6, p=0,041 — có ý nghĩa). Cùng hướng, khác
   sức thống kê. CẤM: "consensus xấu hơn X%", bất kỳ ước lượng độ lớn nào từ cặp 2/8.
7. **Stage nào có LLM, stage nào không?**
   → A: sub-agent thu evidence (không verdict). B: pinned recipe = 0 LLM (fallback worker
   khi không có build command). C: LLM-free. D: heuristic tất cả + LLM chỉ borderline.
8. **"std=0 trên corpus thực nghĩa là gì — không có tin gì để báo?"**
   → Ngược lại: null result có ý nghĩa — LLM được gọi 47–149 lần/run, 0 lật verdict,
   nhất quán 2 corpus độc lập → củng cố RQ1.
9. **"Chi phí?"**
   → Tập P: B6a ≈ 1/4 agentic (4× chiều ngược lại). Tập S: $6,63 full corpus; B6b/B7 ~9×
   token (thế hệ sweep).
10. **Không nhớ chính xác một con số khi bị hỏi — làm gì?**
    → "Tôi không nhớ chính xác con số, nhưng nó nằm trong artifact X, tôi có thể mở lại
    tại chỗ." KHÔNG BAO GIỜ bịa hoặc đoán gần đúng.

---

## 6. Quy tắc vận hành khi trả lời

1. **Một câu = một tập số.** Nếu phải chuyển tập → gọi tên nguồn ("theo artifact
   sweep 2026-08-15, khác với bảng trong paper").
2. **Câu hỏi nhiều ý → lặp khung ý** ("Tôi trả lời hai ý: thứ nhất…, thứ hai…").
3. **Nghe chữ "bằng chứng thống kê" → bắn McNemar**, kèm n, b01/b10, p và tên artifact.
4. **Không nhớ số → trỏ artifact**, không bịa.
5. Mỗi câu trả lời 60–90 giây, 5–8 câu: *vấn đề → bằng chứng + số → cơ chế → hạn chế
   (nếu có) — nói hạn chế trước khi bị hỏi.*
