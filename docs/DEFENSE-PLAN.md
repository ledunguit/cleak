# Kế hoạch hoàn thiện luận văn thạc sĩ (mốc bảo vệ ~2 tháng)

_Lập ngày 2026-08-27, đã kiểm chứng trực tiếp trên repo cùng ngày (mọi con số
trong bảng dưới đối chiếu được với artifact trên đĩa). Nguồn: `results/`,
`docs/EVALUATION.md`, `conference/main.tex`, `docs/CONTRIBUTION.md`._

## Bối cảnh

Hệ thống + nghiên cứu đã đủ chất liệu bảo vệ. Vấn đề trung tâm: **quyển luận văn
(`paper/chapters/*.md`) đang dùng số liệu tháng 6–7** (model `mimo-v2.5-pro`,
mẫu n=30/50/100, LAMeD 44 site), trong khi bộ số mới nhất — đã đo, đã nằm trên
đĩa, đã vào `conference/main.tex` — khác hẳn:

| Chỉ số | Trong quyển (STALE) | Số đúng (đã đo, trên đĩa) | Nguồn |
|---|---|---|---|
| Juliet headline | B6a F1 0.938 (n=50 stratified) | **B6a F1 0.863±0.001 / MCC 0.790, full 1658 ca, $6.63** | `docs/EVALUATION.md` §3b-bis; `results/baseline-sweep-2026-08-15T08-28-06/` |
| LAMeD | 12 TP / 44 site / recall 0.273 | **15 TP / 50 site / recall 0.300, FP=0, std=0 (3 runs)**; `interproceduralFlow` Δ=0 | `results/lamed-correction-2026-08-20-README.md`, `results/lamed-llm_assisted-2026-08-20/` |
| Consensus | n=30: consensus thắng (flip 6.7% vs 13–27%) | **n=50 stratified: ĐẢO NGƯỢC** — single flip 2.0%/F1 0.852 thắng consensus 8.0%/F1 0.793; McNemar p=0.077 | `results/consensus-ablation-n50-2026-08-19.log` |
| Đóng góp C1–C4 | Ch5: C1 = Consensus judge | `docs/CONTRIBUTION.md`: C1 = pipeline tất-định-trừ-judge, **C4 = consensus, "không còn novelty trung tâm"** | `docs/CONTRIBUTION.md` |
| MemHint | Không có trong quyển | Chưa có artifact nào (run no_llm cũ mất artifact) — **khoảng trống duy nhất** | — |

Quyết định đã chốt: deadline ~2 tháng · quyển **Word (.docx)** theo template
trường (dùng word-document-server MCP; trường chưa cung cấp template ngoài
khung `paper/scaffold.md`) · **MemHint đưa vào đầy đủ** · kế hoạch bao gồm cả
chạy thực nghiệm.

---

## Giai đoạn 0 — Dọn trạng thái (ngày 1, ~1 buổi)

1. Cập nhật `CURRENT_STATUS.md`: đánh dấu pending #1 (LAMeD re-run) và #3
   (Juliet llm_assisted full) là ĐÃ XONG, trỏ tới artifact 2026-08-20 /
   `results/eval-llm_assisted-juliet-full/`; pending #4 (consensus gate) đóng
   bằng kết quả n=50.
2. Đóng Word trước khi thao tác .docx (lockfile `~$ cuong LVThS...docx` đang
   tồn tại).

## Giai đoạn 1 — Thực nghiệm còn thiếu: MemHint (tuần 1) rồi FREEZE

Chỉ còn **1 corpus** cần chạy. Hai run, cùng setup:

**Setup chung (một lần):**

```bash
docker compose up --build -d
export EVAL_STATIC_URL=http://127.0.0.1:50061/mcp EVAL_DYNAMIC_URL=http://127.0.0.1:50062/mcp
cleak config set eval.staticPathMap "$(pwd)/demo=/workspace/demo"   # BẮT BUỘC — thiếu là mất cross-file ownership, không báo lỗi
# pricing đã config sẵn cho model? kiểm tra: cleak config get | grep pricing
```

Ghi chú (đã kiểm chứng 2026-08-27): `demo/memhint/cases/` ĐÃ materialize sẵn
19 case (curl/freerdp/…) + `corpus_manifest.json` + validation report — KHÔNG
cần chạy lại `scripts/memhint/ingest.ts`, chỉ cần eval chạy qua corpus
integrity gate là đủ. `LLM_PROVIDER=<tên profile>` là env có thật
(`packages/config/src/loader.ts:45`) — giá trị là KEY của named profile trong
`llm.endpoints` ở `~/.config/cleak/config.json` (dùng đúng profile
deepseek-v4-flash như run LAMeD 2026-08-20). Ngoài env, cũng có flag
`--static-url`/`--dynamic-url` thay cho `EVAL_STATIC_URL`/`EVAL_DYNAMIC_URL`
(default trong code là `:50071`/`:50072`, Docker stack là `:50061`/`:50062`).

**Run 1 — MemHint `no_llm --enrich` (tái tạo artifact 42.3% đã mất):**

```bash
pnpm exec tsx scripts/evaluate-corpus.ts no_llm \
  --corpus demo/memhint --enrich --dynamic selective \
  --out-dir results/memhint-no_llm-<date>
```

**Run 2 — MemHint `llm_assisted`, 3 runs (đối xứng với LAMeD 2026-08-20):**

```bash
LLM_PROVIDER=<deepseek-v4-flash profile> pnpm exec tsx scripts/evaluate-corpus.ts llm_assisted \
  --corpus demo/memhint --enrich --dynamic selective \
  --static-tools candidateScan,functionSummary,pathConstraints,interproceduralFlow \
  --no-tool-select --strategy off --consensus-n 1 --no-judge-cache --runs 3 \
  --out-dir results/memhint-llm_assisted-<date>
```

Lưu ý vận hành (từ kinh nghiệm LAMeD run): `--out-dir` bắt buộc để `--resume`
hoạt động; provider quota có thể cạn giữa chừng → resume ~2 lần; repo MemHint
lớn (vim/redis/openssl/freerdp) → để `--concurrency` thấp (4–8). `--no-judge-cache`
bắt buộc khi `--runs > 1`.

Về `--enrich`: lệnh LAMeD 2026-08-20 trong README không có `--enrich` nhưng
vẫn đạt R 30% — vì đường resolve capability tự bật enrich khi
`static && fusion && !tool_selector` (`capabilityResolver.ts:65`); riêng
baseline `no_llm` thuần thì mặc định giữ enrich OFF (comment dòng 14–18 cùng
file, và `docs/DATASETS.md:57` xác nhận 15.9% vs 29.5% trên LAMeD). Kết luận:
**giữ `--enrich` tường minh trong cả 2 lệnh MemHint** (vô hại nếu trùng
default), chạy `--dry-run` trước để in effective config, và ghi setting
enrich thực tế vào RESULTS-FREEZE.

**Sau đó FREEZE — viết `docs/RESULTS-FREEZE.md`** (single source of truth mọi
chương/slide/paper trích từ đây): mỗi dòng = thí nghiệm, commit hash, corpus
hash, model, ngày, đường dẫn `results/`, con số headline. Nội dung gồm: Juliet
full 9-baseline sweep + `eval-llm_assisted-juliet-full` + chuỗi `no_llm`
postfix4; LAMeD bộ 2026-08-20 (4 thư mục); consensus n=50; allocator-profile
validation 2026-08-19; MemHint mới. **Không chạy thêm thực nghiệm sau mốc này.**

## Giai đoạn 2 — Đồng bộ nội dung các chương (tuần 2–4)

Nguyên tắc: `conference/main.tex` + `docs/CONTRIBUTION.md` là bản kể chuyện
mới nhất (đã fact-check các commit `c5826bc`→`425d76f`) — port sang quyển,
không viết lại từ đầu. Văn mới tuân `paper/HUMANIZER-GUIDELINES.md`.

**`chapter4-evaluation.md` (nặng nhất):**

- §4.1.6: model `mimo/mimo-v2.5-pro` → bộ config thật của các run chốt
  (`deepseek-v4-flash`, gateway openai-compat), nêu rõ run nào dùng model nào.
- §4.2: thay headline bằng **full-corpus 1658 sweep** (9 dòng B1–B7, F1/MCC/chi
  phí $, từ `docs/EVALUATION.md` §3b-bis — lưu ý artifact `baseline-sweep.md`
  trên đĩa chỉ ghi 1 dòng B7, bảng đủ nằm trong docs). Giữ bảng n=50/n=100
  stratified làm phụ + **một đoạn hòa giải**: vì sao stratified 0.938 vs full
  0.863 (mẫu đều 10 family vs corpus skew, `new` 588/1658; family variance F1
  0.991 malloc → 0.584 strdup).
- §4.5: LAMeD 44→**50 site**, recall 0.250/0.273 → **0.300**, thêm phát hiện
  `interproceduralFlow` Δ=0 (byte-identical, root cause path-insensitivity) và
  `llm_assisted` == `no_llm` trên LAMeD (LLM được gọi 47–149 lần/run nhưng
  không lật verdict). Giữ case study cjson merge_patch.
- §4.6: **viết lại toàn bộ** theo n=50 stratified reversal + McNemar 205 site
  p=0.077; giữ n=30 như thí nghiệm đầu để kể trung thực trình tự phát hiện
  (đây là điểm cộng phương pháp luận, không phải điểm yếu).
- §4.7: cập nhật bảng so sánh ngoài theo `tab:external`/`tab:literature` của
  main.tex (Clang SA trên LAMeD: 43 site, TP0). Kèm chú thích denominator
  43 vs 50 site là **by design của scorer** (mỗi hệ được chấm trên finding
  granularity của chính nó), không phải bug — lập luận đầy đủ ở
  `results/lamed-correction-2026-08-20-README.md` mục 4.
- **Thêm mục mới §4.x MemHint**: mô tả corpus 19 ca tự tái lập (ground truth
  `demo/memhint/memhint_bugs.json`), kết quả 2 run mới, so với dải MemHint
  paper tự báo.
- §4.10: cập nhật bảng tổng hợp + kết luận "điều kiện nào LLM orchestration
  có lợi" theo số mới.

**`appendix-a-confusion-matrices.md`:** thay A.5 (LAMeD 50 site), A.6
(consensus n=50), thêm A.8 MemHint; cân nhắc thêm bảng full-corpus sweep.

**`chapter5-conclusion.md`:** viết lại RQ1–RQ4 theo số mới (RQ1: so **cùng
sweep, cùng commit `5eec8b1`** — B6a F1 0.863 vs B1 static-only 0.612, LLM
judge CÓ giúp trên full corpus, khác kết luận cũ từ n=30. LƯU Ý: KHÔNG dùng
cặp "0.776 vs 0.612" — run `eval-llm_assisted-juliet-full` F1 0.776 sinh
2026-08-11, TRƯỚC chuỗi fix reference-out-param/virtual-dispatch/RAII
2026-08-12 vốn tạo ra baseline 0.612, so lệch thế hệ code; run 0.776 chỉ dùng
làm dữ liệu chi phí/judge-path, phải ghi rõ commit trong RESULTS-FREEZE.
RQ3: đảo chiều, không khuyến nghị consensus mặc định);
**đánh số lại C1–C4 khớp `docs/CONTRIBUTION.md`** (C1 = pipeline tất-định-trừ-
judge, C4 = consensus negative-result).

**`chapter1-related-work.md`:** sửa lỗi trùng đánh số `### 1.4.3` (dòng 184 và
190) → lệch toàn bộ 1.4.x.

**Rà chéo cuối giai đoạn:** grep mọi con số headline (0.938, 0.273, 44 site,
6.7%, mimo…) trên `paper/` + `docs/` + `conference/` để bắt sót; cập nhật
`docs/THESIS.md`/`docs/CONTRIBUTION.md` nếu MemHint cho kết quả đáng ghi.

## Giai đoạn 3 — Quyển .docx theo template trường (tuần 4–6)

1. **Xin template chính thức từ trường/GVHD NGAY tuần 1** (hiện chỉ có khung
   `paper/scaffold.md` + đề cương .docx). Nếu không có template file, dựng
   theo quy định định dạng chuẩn LVThS (khổ A4, lề, font, đánh số) và khung
   scaffold.
2. Dựng quyển bằng word-document-server MCP
   (ước lượng ch1 ~25tr, ch2 ~30tr, ch3 ~20tr, ch4 ~30tr, ch5 ~15tr):
   - Front matter: bìa, lời cam đoan, lời cảm ơn, tóm tắt Việt/Anh, mục lục,
     danh mục hình/bảng/viết tắt (nguồn viết tắt: `docs/GLOSSARY.md`).
   - Thân: 5 chương đã đồng bộ ở Giai đoạn 2.
   - Tài liệu tham khảo: `paper/references/bibliography.md` (IEEE, đã kiểm
     chứng DOI/arXiv) — giữ nguyên đánh số [1]–[N].
   - Phụ lục A–D từ `paper/chapters/appendix-*.md`.
3. **Hình vẽ chất lượng in**: render các sơ đồ mermaid từ
   `docs/SYSTEM-DIAGRAM.md`, `docs/sequence-diagrams.md` thành PNG/SVG độ
   phân giải in; `diagrams/` chỉ có `architecture.drawio` — export từ
   draw.io. Chèn có caption + đánh số "Hình x.y".
4. Xuất PDF (`convert_to_pdf`), tự soát 1 vòng (chính tả, số trang, tham chiếu
   chéo hình/bảng), rồi **gửi GVHD review** — chừa tuần 6 cho vòng sửa.

## Giai đoạn 4 — Chuẩn bị bảo vệ (tuần 6–8)

1. **Slide ~20–25 phút** (dựng từ nội dung quyển): bài toán → kiến trúc HYBRID
   4 tầng (1 sơ đồ) → 3 kết quả đinh: (a) Juliet full-corpus B6a F1 0.863,
   agentic tool-selection tốn ~4× $ cho F1 thấp hơn; (b) dự án thực LAMeD
   15/50 + MemHint, FP=0, Clang SA bắt 0; (c) consensus reversal — phát hiện
   phương pháp luận về stratified sampling → hạn chế & hướng phát triển.
2. **Demo**: kịch bản live 1 ca cjson `merge_patch` (hoặc libtiff) chạy TUI
   end-to-end + video quay sẵn dự phòng.
3. **Q&A dự kiến** (soạn câu trả lời viết sẵn): chỉ 1 LLM chính — tổng quát
   hóa? (đã có sweep B6a-mimo/zai làm bằng chứng phụ); LAMeD/MemHint
   positive-only — precision đo sao? (quy ước `docs/BASELINE-COMPARISON.md`:
   recall + FP count); Juliet synthetic có đại diện? (family variance +
   real-project corpora); **vì sao "cơ chế đồng thuận" trong tên đề tài lại
   không được khuyến nghị?** — câu này chạm tên đề tài, cần tập kỹ: khung trả
   lời = "mục tiêu là ĐÁNH GIÁ cơ chế; đánh giá nghiêm túc cho kết quả âm có
   giá trị khoa học, và chỉ ra hiệu ứng sampling mà nghiên cứu LLM-judge
   trước đó bỏ qua".
   - **"Claim headline B6a vs B1 — anh có kiểm định thống kê không?"** — Có.
     McNemar paired trên cặp ghép `siteId`, full corpus: n = 6037, b01 = 51 /
     b10 = 1236, χ² (hiệu chỉnh Edwards) = 1089.2432, p = 7.192e-239 — B6a tốt
     hơn B1 có ý nghĩa thống kê ở α=0.05; lợi thế F1 0.864 vs 0.612 không phải
     nhiễu aggregate. Tool: `scripts/mcnemar-compare.ts`; artifact:
     `results/baseline-sweep-2026-08-15T08-28-06/{B1,B6a/run-1}/metrics.json`;
     bằng chứng chạy: `.omo/evidence/review-remediation/task-8/mcnemar-b6avs-b1.txt`.
   - **"+0.001 F1 của planner (B6 vs B6a) — chọn B6a dựa trên gì?"** — Không
     dựa trên +0.001: McNemar paired cho B6 vs B6a (run-1, n = 6042) cho b01 =
     73 / b10 = 66, χ² = 0.2590, p = 0.611 — KHÔNG có ý nghĩa thống kê, hai cấu
     hình tương đương. Quyết định: giữ B6a làm cấu hình sản xuất vì planner
     cung cấp planner-status/coverage cho nhánh dynamic fallback (giá trị vận
     hành, không phải F1) — đã ghi vào §4.2.2 và §4.11 của chương 4. Tool:
     `scripts/mcnemar-compare.ts`; bằng chứng chạy:
     `.omo/evidence/review-remediation/task-8/mcnemar-b6-vs-b6a.txt`.
4. Tóm tắt luận văn (nếu trường yêu cầu) — rút từ quyển.

## Descope — dứt khoát KHÔNG làm (chỉ ghi vào "hạn chế & hướng phát triển")

Flow-variant Juliet còn lại (44/45/63–68 C++ reference shapes, 81–82 virtual
dispatch FN, 83–84 RAII FN) · Docker `deploy.resources.limits` · so sánh
multi-model đầy đủ · SMT/Z3 path feasibility · nộp conference paper (chỉ làm
nếu còn dư thời gian sau tuần 6).

## Verification

- **Giai đoạn 1**: `variance.md` của MemHint llm_assisted có std hợp lệ (không
  giả-0 do cache); 19/19 scored, 0 errors; số vào `docs/RESULTS-FREEZE.md`
  khớp `metrics.json` trên đĩa.
- **Giai đoạn 2**: grep các số cũ (`0.938`, `0.273`, `44 site`, `6.7%`,
  `mimo-v2.5-pro`) trong `paper/` chỉ còn xuất hiện ở ngữ cảnh "thí nghiệm
  sớm/lịch sử" có chú thích; mọi bảng chương 4 đối chiếu 1-1 với
  RESULTS-FREEZE.
- **Giai đoạn 3**: PDF xuất được, mục lục/danh mục tự động đúng, mọi hình/bảng
  được tham chiếu trong văn bản; GVHD confirm format.
- **Giai đoạn 4**: chạy thử demo trên máy sạch (hoặc container) trước ngày
  bảo vệ; slide khớp số với quyển.

## Rủi ro & dự phòng

- Provider quota cạn giữa run MemHint → `--resume` với cùng `--out-dir`.
- Repo MemHint lớn gây timeout MCP → hạ `--concurrency`, tăng
  `STATIC_PARSER_WORKERS` theo `docs/OPERATIONS.md` §6.
- Trường có template .docx bắt buộc khác dự kiến → chi phí re-format; hỏi
  template NGAY tuần 1, đừng đợi tuần 4.
- MemHint llm_assisted có thể lặp lại pattern LAMeD (LLM không lật verdict) —
  vẫn là kết quả báo cáo được (nhất quán, củng cố kết luận RQ1 trên corpus
  thực).

## Bổ sung 2026-09-21 (review-remediation)

### (S6) Ô còn thiếu "Clang + LLM judge": câu trả lời viết sẵn (Defense Q15)

Câu hỏi hội đồng có thể đặt: bảng capability 9 baseline có B4 "LLM + static
của chúng tôi" nhưng không có ô **"Clang + LLM judge"** (thay lớp static của
hệ thống bằng Clang thô, giữ nguyên judge LLM) nên không tách rời được đóng góp
riêng của enrich layer. Kịch bản nói sẵn:

> "B4 là 'LLM + static của chúng tôi', không phải 'Clang + LLM judge'; ô đó
> chưa chạy (thí nghiệm ~1 tuần); nếu được hỏi: thừa nhận, lập luận
> enrich-layer hội-tụ về B4-với-ứng-viên-khác, cam kết chạy nếu hội đồng muốn."

Mở rộng thành ba bước khi trả lời:

1. **Thừa nhận thẳng**: ô đó chưa chạy, không bịa số, không có artifact.
2. **Lập luận hội-tụ**: dữ liệu đã đo cho thấy chất lượng ứng viên đầu vào là
   yếu tố quyết định, judge chỉ khuếch đại ứng viên đó. Clang thô trên LAMeD:
   43 site, TP 0 (Bảng 4.8, `results/lamed-correction-2026-08-20-README.md`
   mục 4); Clang trên Juliet F1 ~0.76 so với B1 0.612 / B6a 0.863 cùng scorer.
   "Clang + LLM judge" vì vậy hội tụ về B4-với-ứng-viên-khác: cùng cấu trúc
   (LLM judge trên static evidence), chỉ khác nguồn ứng viên yếu hơn, và kết
   quả dự kiến bị chặn trên bởi recall/precision của nguồn đó.
3. **Cam kết**: thí nghiệm ~1 tuần, khả thi vì `--static-tools` và adapter
   clang đã có sẵn (`domain/baselines/clangAnalyzer.ts`); nếu hội đồng muốn,
   nhận chạy và báo phụ lục.

Ghi chú cho bản thân (không nói): đừng biến câu trả lời thành hứa bổ sung phạm
vi; Scope-note addendum giữ thí nghiệm này ở mức OPTIONAL, threat model bắt
buộc đã có ở ch3 §3.8.2.

### (C.2) Khung trình bày reversal consensus: SIGN-REVERSAL, không phải ước lượng effect size

Câu hỏi cần chặn trước: **"2%-vs-8% trên 50 case đã đủ chưa?"** Đừng bảo vệ độ
lớn của con số. Điểm của kết quả không phải "consensus tệ hơn đúng 6 điểm phần
trăm", mà là **đảo dấu (SIGN-REVERSAL)** giữa hai scheme lấy mẫu:

- n=30 (top-N, 2026-06): consensus thắng, flip 6.7% so với single 13.3-26.7%.
- n=50 stratified (2026-08-19): dấu đảo hoàn toàn, single 2.0%/F1 0.852 so với
  consensus 8.0%/F1 0.793; McNemar p=0.077 (bảng ở mục "Bối cảnh" đầu tài
  liệu này).

Ba mệnh đề được phép nói, và chỉ ba:

1. Kết luận rút từ MỘT cỡ mẫu duy nhất về độ ổn định verdict của judge LLM đã
   đảo chiều hoàn toàn khi đổi scheme lấy mẫu (đây là phát hiện phương pháp
   luận: các nghiên cứu LLM-judge trước đó công bố số stability trên một
   sample duy nhất).
2. Ở n=50, khác biệt 2% vs 8% CHƯA có ý nghĩa thống kê ở α=0.05 (p=0.077),
   đúng như khung: chúng tôi không claim effect size, chỉ claim dấu hiệu
   không-bền-vững.
3. Khuyến nghị vận hành giữ nguyên: không dùng consensus làm mặc định (C4),
   vì không còn bằng chứng lợi ích tương xứng chi phí.

Không được nói: "consensus xấu hơn X%", "cần thêm n để xác nhận consensus tệ",
hoặc bất kỳ dạng ước lượng độ lớn nào từ cặp 2/8 này.

Hai kiểm định McNemar còn lại của tài liệu (B6a-vs-B1 p=7.192e-239; B6-vs-B6a
p=0.611) đã có sẵn ở mục Q&A Giai đoạn 4 bên trên: trỏ về đó khi cần, KHÔNG
nhắc lại số trong câu trả lời về consensus để tránh trộn hai cặp so sánh.
