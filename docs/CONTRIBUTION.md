# Đóng góp & tính học thuật

> Tài liệu này trình bày chi tiết các đóng góp của luận văn, **kết quả đo được thật**,
> và **bàn luận trung thực** (gồm cả kết quả không như kỳ vọng). Tổng quan: [THESIS.md](THESIS.md).
> Phương pháp & định nghĩa metric: [EVALUATION.md](EVALUATION.md). Định vị so với SOTA:
> [RELATED-WORK.md](RELATED-WORK.md).

---

## C1 — Consensus judge: hợp nhất static+dynamic + self-consistency

**Vấn đề.** Một judge LLM đơn lẻ ở `temperature=0` vẫn **lật verdict giữa các lần chạy**
trên các ứng viên *biên* (provider không thật sự tất định bit-for-bit). Đồng thời, bằng
chứng static (cấu trúc) và dynamic (runtime) thường **mâu thuẫn** và một judge ngây thơ
không có cơ chế hoà giải.

**Cách làm.** `packages/common/src/analysis/consensus-judge.ts` lấy *k* mẫu verdict LLM
**độc lập** (self-consistency, nhiệt độ lấy mẫu > 0 để đa dạng) rồi `combineVerdicts`
theo một trong ba luật: `majority | weighted | unanimous-to-flag`. Sau bỏ phiếu, một
**precision-override heuristic** có thể veto một FLAG nếu `judgeHeuristically` tự tin
miễn tội (không bao giờ veto khi dynamic đã xác nhận; chỉ *gỡ* flag, không thêm). Judge
đọc **`dynamicCoverage`** (không phải `evidence.length`) nên một hàm sạch được miễn tội
ngay cả khi 0 evidence.

- `n = 1` ⇒ **single-LLM baseline** (không đổi) → ablation 3-bậc *heuristic | single-LLM
  | consensus-k* là so sánh **như-với-như** (chỉ tầng judge đổi).
- Tầng module nằm trong `packages/common` (không import app); lời gọi LLM được **tiêm vào**
  (injected) để giữ tính thuần và test được.
- Escalation thông minh (`llmJudge.ts` `shouldEscalate`): leo thang lên consensus **khi
  static↔dynamic bất đồng**, không chỉ khi heuristic lưỡng lự.

**Kết quả** → xem [§Kết quả](#kết-quả-đo-được).

## C2 — Giao thức tái lập hai tầng (two-tier reproducibility)

Một con số chỉ bảo vệ được nếu **tái lập được**. Nhưng hai chế độ có bản chất tất định
khác nhau, nên luận văn báo cáo mỗi chế độ theo đúng bản chất của nó (chi tiết:
[EVALUATION.md §7](EVALUATION.md)).

- **Tier-1 — `no_llm` tất định bit-for-bit.** Toàn bộ đường phi-LLM (heuristic judge +
  recipe dynamic ghim + capture tất định + scoring) cho **kết quả chấm điểm y hệt** giữa
  hai lần chạy. Được ép bằng gate `scripts/determinism-gate.sh` + `scripts/assert-determinism.ts`.
  Gate **từ chối hai kiểu "đậu giả"** đã gặp thật: (a) *self-compare* — dấu thời gian
  giây trùng làm hai lần chạy ghi vào cùng thư mục nên so dir-với-chính-nó; (b) *degenerate*
  — analyzer mất kết nối làm mọi ca lỗi, hai "đống lỗi" giống nhau bị nhận nhầm là "tất định".
- **Tier-2 — `llm_assisted` báo cáo dao động, không phải đồng nhất.** Vì không thể đạt
  đồng nhất bit-for-bit với judge LLM, số liệu được báo cáo dạng phân phối:
  `evaluate-corpus.ts --runs N` (mean ± std) + `scripts/verdict-stability.ts` (tỉ lệ lật
  verdict cấp-ca). Điểm mấu chốt: **aggregate có thể trùng do may** trong khi verdict từng
  ca vẫn dao động — `verdict-stability.ts` phơi bày điều đó thay vì để một tổng "may mắn"
  che giấu.

## C3 — Tất định hoá tầng dynamic

**Vấn đề gốc.** Trong thiết kế cũ, tầng dynamic (Stage B) là một **LLM sub-agent** tự
quyết chọn sanitizer/build/run và *ghi* evidence theo ý mình → coverage và verdict đổi
giữa các lần chạy (trong khi tầng static đã tất định).

**Cách làm.**
- `runDeterministicDynamic` (`apps/leak-inspector-tui/src/domain/dynamicEvidence.ts`):
  **ghim recipe** build (LeakSanitizer) + run — **không có LLM trong vòng *chạy*** → run
  tất định → coverage tất định.
- `withDynamicEvidenceCapture` bọc các tool sanitizer và **ghi MỌI finding** vào store
  (không có "discretion" của LLM, đối xứng với `withStaticContextCapture`);
  `reconcileDynamicEvidence` gộp finding vào bundle tương quan nhất (idempotent).
- `dynamicCoverage` trung thực: `exercised_clean | exercised_leak | not_exercised | dynamic_off`
  thay cho việc suy diễn từ `evidence.length`.

**Lưu ý trung thực:** ghim tầng dynamic loại bỏ dao động *do dynamic*, nhưng `llm_assisted`
**vẫn** lật verdict do **judge LLM** (bản chất sampling phía provider) — đó chính là lý do
tồn tại Tier-2 + consensus (C1), thay vì cố ép LLM tất định.

## C4 — Làm giàu bằng chứng cho judge

Để judge (và báo cáo) lập luận được, mỗi bundle mang bằng chứng có cấu trúc:
- **Ownership** (vai trò allocator/caller, lý do), **cặp alloc→free** (paired/unpaired),
  **feasible-leak-path** (narrative đường rò khả thi + mức rủi ro + reachable).
- **Tương quan** runtime↔ứng viên: `correlationMethod` phân **LINKED** (file_line_exact/near,
  function_match — quyết định) vs **file-only** (yếu) vs unlinked; kèm `leakKind`, `allocSite`,
  `bytesLost`.

Các tín hiệu này được **lưu vào `snapshot.json`** và hiển thị trong báo cáo md/html + trình
duyệt findings của TUI (verdict card), nên một verdict luôn **truy vết được** về bằng chứng.

---

## Kết quả đo được

Trên **Juliet CWE-401** (30 ca, analyzer qua MCP Docker; số liệu thật đã chạy trong dự án):

### Hệ thống vs baseline static
| Hệ | Precision | Recall | F1 |
|---|---|---|---|
| **leak-investigator** (no_llm heuristic) | **0.806** | **0.906** | **0.853** |
| Clang Static Analyzer (cùng corpus, cùng `scoreCase`) | ~0.69 | ~0.84 | **~0.76** |

> Heuristic dùng tín hiệu cấu trúc cấp nguồn (định vị missing-free site) làm static evidence,
> nên `no_llm` thực sự *phát hiện* leak chứ không trả về toàn `uncertain`. Số baseline clang
> tái tạo qua [BASELINE-COMPARISON.md](BASELINE-COMPARISON.md) (chạy lại live, không phải số bịa).

### Consensus giảm dao động verdict (ablation, headline)
Cùng 30 ca, cùng analyzer, 2 lần chạy mỗi nhánh; ablation chạy **2 đợt** (A, và B sau khi
siết tương quan dynamic↔candidate):

| Nhánh judge | đợt | case-stability | **tỉ lệ lật verdict** | modal agreement |
|---|---|---|---|---|
| single-LLM (`--consensus-n 1`) | A | 73.3% | **26.7%** (8/30) | 86.7% |
| single-LLM (`--consensus-n 1`) | B | 86.7% | **13.3%** (4/30) | 93.3% |
| consensus (`--consensus-n 3`)  | A | **93.3%** | **6.7%** (2/30) | **96.7%** |
| consensus (`--consensus-n 3`)  | B | **93.3%** | **6.7%** (2/30) | **96.7%** |

→ **Bỏ phiếu k=3 cắt tỉ lệ lật verdict ~2–4×** (single 13–27% → consensus 6.7%). Trung thực:
(1) nhánh **consensus lặp lại Y HỆT** qua 2 đợt (6.7%/93.3%/96.7%) — đây là tính chất *ổn định*,
không phải số may; (2) **tỉ lệ lật của single-LLM tự nó dao động** (26.7% rồi 13.3%) — chính sự
bất ổn đó là thêm bằng chứng cho dao động mà consensus nhắm dập. Claim vững = *có hướng + có biên*:
consensus ổn định hơn ~2–4×, bội số chính xác phụ thuộc baseline single-LLM (vốn nhiễu).

**Hiệu ứng ghép cặp (McNemar, đợt B, 77 site, single vs consensus):** consensus cao hơn
(acc 83.1%/F1 0.822 vs single 79.2%/F1 0.784); trong các site bất đồng, 5 nghiêng về consensus,
2 nghiêng về single (χ²=0.57, **p=0.45**). Tức **có hướng** nghiêng consensus nhưng **chưa có ý
nghĩa thống kê ở n=30** (quá ít cặp bất đồng) → báo cáo như xu hướng + CI, cần multi-seed / corpus
khó hơn trước khi khẳng định "thắng" theo paired test. (`scripts/mcnemar-compare.ts <runA> <runB>`.)

### Tier-1 tất định
Hai lần chạy `no_llm` (thư mục tách biệt, cùng cấu hình) cho **chấm điểm y hệt**: TP29 FP7
FN3 TN38. Gate `determinism-gate.sh` chứng nhận; đồng thời từ chối đúng hai kiểu đậu-giả.

---

## Bàn luận trung thực (threats to validity)

- **Trên Juliet *dễ*, heuristic baseline là mạnh nhất (F1 0.853).** LLM + dynamic trên
  corpus tổng hợp đơn giản có thể **TĂNG FP** (ví dụ consensus×3 + `--dynamic selective`
  từng cho FP cao hơn cả dyn-off), vì bằng chứng dynamic làm heuristic *tự tin hơn* → ít ca
  rơi vào dải biên nơi consensus phát huy, và tương quan dynamic↔ứng viên còn thô. Giá trị
  của LLM/consensus kỳ vọng thể hiện trên **ca khó** (dự án thực, control-flow phức tạp).
- **Hướng cải thiện đã thử:** escalation theo *bất đồng* static↔dynamic (`shouldEscalate`)
  đã *re-engage* consensus và thu hồi phần lớn FP regression — nhưng vẫn cần tương quan
  dynamic↔ứng viên chặt hơn. Đây là việc còn mở.
- **Dao động single-run:** mọi con số FP đơn-lần-chạy đều bị nhiễu bởi tính bất định của LLM
  → **luôn dùng multi-seed + McNemar/bootstrap** (đã có công cụ) trước khi quy kết hiệu ứng
  cho một thay đổi code.
- **Baseline mỏng & preprint:** chỉ LAMeD (EASE 2025) là peer-review đầy đủ cho leak C/C++;
  phần còn lại là preprint/tech-report (xem caveat ở [RELATED-WORK.md](RELATED-WORK.md)).
- **Quy mô:** corpus chính là Juliet tổng hợp; real_projects mới 4 ca (2 cặp cJSON) → kết
  luận trên dự án thực cần mở rộng corpus.
- **PHÁT HIỆN QUAN TRỌNG trên LAMeD thật (cjson 6 ca, materialize + chạy live cả 4 cấu hình).**
  **recall = 0% ở MỌI cấu hình**: `no_llm` và `llm_assisted`, *trước* và *sau* khi sửa discovery.
  Đây là kết quả phân-tầng, trung thực:
  - **Tầng 1 — discovery:** leak cJSON ở **factory function** (`cJSON_Duplicate`,
    `cJSON_CreateObject` → `cJSON_New_Item`), tên không chứa token `malloc/alloc` → candidate-scan
    không thấy site cấp phát. **Đã sửa** bằng `EXTRA_ALLOCATOR_NAMES` (allocator annotation theo
    project, ≈ LAMeD AllocSource) → candidate 40→68/ca, **factory-alloc site giờ LÀ candidate**.
  - **Tầng 2 — judging:** *kể cả khi* leak site đã là candidate VÀ LLM judge chạy (19 verdict LLM),
    recall **vẫn 0%**. Vì leak cJSON là **path-sensitive + interprocedural ownership**: một object
    `cJSON_Duplicate` được thêm vào struct cha, nhưng trên một đường *error/early-return* cụ thể thì
    struct không được free → leak. Judge per-candidate/per-function (chỉ thấy snippet hàm bao) hợp
    lý kết luận "ownership đã chuyển cho struct → không leak", **bỏ sót** việc struct rò trên đường lỗi.
  - **Taxonomy 6 leak cjson (đọc TRỰC TIẾP từ 6 fix-commit thật):** (1+2) **deallocator-semantics**
    — `cJSON_Duplicate`/`cJSON_ReplaceItemInObject`: buffer `cJSON_strdup` gắn cờ `cJSON_StringIsConst`
    nên `cJSON_Delete` *bỏ qua không free* → leak; cần MÔ HÌNH HOÁ ngữ nghĩa deallocator (gần như
    bất khả thi nếu không biết cJSON_Delete bỏ qua const). (3+4) **missing-free trên một đường**
    — `merge_patch` thiếu `cJSON_Delete(target)`, `...FindPointer...` thiếu `cJSON_free(full_pointer)`
    trên đúng một đường lỗi → *path-sensitive*, lớp DUY NHẤT có hi vọng bắt nếu wire path-constraints
    vào judge. (5) **control-flow** `suffix_object`: reorder + null-guard trước alloc — tinh vi.
  - **Kết luận:** real-project recall = 0% KHÔNG phải vì hệ yếu một chỗ mà vì 6 leak thuộc các lớp
    KHÓ khác nhau: 2 cần deallocator-semantics, 2 path-sensitive, 1 control-flow, 1 file-level. Cần
    **CẢ** (a) allocator annotation cho discovery (đã làm), VÀ (b) judging path-sensitive +
    interprocedural + deallocator-model. Đây trùng với chính LAMeD (SOTA cũng chỉ bắt ~5–10/43). Đây
    là đặc tả CHÍNH XÁC, case-by-case, vì sao leak dự án thực khó — đo trên corpus peer-review.
    (Quá trình lộ + sửa 4 bug thật: ingest repo_path; `cJSON_malloc` pattern; **Docker build vỡ**
    thiếu COPY `tsup.config.ts` — analyzer un-rebuildable từ migration tsc→tsup; + feature
    `EXTRA_ALLOCATOR_NAMES`. gRPC removal validated e2e trên cả 2 analyzer image mới.)

---

## Bản đồ "đóng góp ↔ bằng chứng"

| Đóng góp | Cài đặt | Bằng chứng / số liệu |
|---|---|---|
| C1 Consensus judge | `packages/common/src/analysis/consensus-judge.ts`; `llmJudge.ts` (`shouldEscalate`) | flip 26.7%→6.7%; ablation `scripts/consensus-ablation.sh` |
| C2 Two-tier determinism | `scripts/{determinism-gate.sh,assert-determinism.ts,verdict-stability.ts}` | Tier-1 TP29 FP7 FN3 TN38 y hệt; [EVALUATION.md §7](EVALUATION.md) |
| C3 Dynamic tất định | `apps/leak-inspector-tui/src/domain/dynamicEvidence.ts` (`runDeterministicDynamic`, `withDynamicEvidenceCapture`) | coverage tất định; recipe ghim |
| C4 Evidence enrichment | `packages/common` (ownership/pairs/feasible-path/correlation); reporting.ts | `snapshot.json` + verdict card; báo cáo md/html |
