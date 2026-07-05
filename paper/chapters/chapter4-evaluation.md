# Chương 4: Đánh giá kết quả

Mọi thiết kế đều là giả thuyết cho đến khi được kiểm chứng bằng thực nghiệm. Chương này trình bày kết quả đánh giá trên hai corpus — Juliet CWE-401 (corpus synthetic, 1658 ca) và LAMeD benchmark (corpus dự án thực, 41 ca) — với các ablation study phân rã đóng góp từng thành phần. Số liệu được báo cáo trung thực, kể cả khi chúng không như kỳ vọng.

---

## 4.1. Thiết kế thực nghiệm

### 4.1.1. Corpus

**Juliet CWE-401 validated:** 1658 test cases, lockfile `f578c3ee`, 0 quarantined. Đây là phiên bản re-ingest từ NIST v1.3, đã fix lỗi C++ multi-file variant (422/1984 ca cũ không build được) và label drift (1171 ca cũ bị mislabel). Mỗi ca có ground truth: `flaws[]` (hàm leak) và `clean[]` (hàm sạch).

**LAMeD benchmark:** 41 leak từ 7 dự án thực (curl 14, libtiff 6, libsolv 6, cjson 6, libxml2 4, libssh2 3, rabbitmq-c 2). Positive-only — không có label sạch nên chỉ đánh giá recall, FP count, FP/KLOC.

### 4.1.2. Scoring model

Function-mode cho Juliet: hàm bao là site. Bất kỳ finding nào trong hàm `bad` → positive prediction; trong hàm `good` → negative. Nhiều finding cùng hàm collapse thành một sample — không inflate TP/FP.

Verdict được tính là "flagged" (positive prediction) khi verdict ∈ {confirmed_leak, likely_leak}.

### 4.1.3. Metrics

- **Precision (P):** TP / (TP + FP)
- **Recall (R):** TP / (TP + FN)
- **F1:** harmonic mean of P and R
- **ECE (Expected Calibration Error):** đo calibration của confidence
- **FP/KLOC:** false positive per thousand lines of code

### 4.1.4. Sampling

`--stratify` chọn mẫu evenly qua deterministic round-robin theo `functionalVariant`. Điều này đảm bảo ngay cả sample nhỏ (n=50) cũng bao phủ tất cả 10 families (char, int, malloc, new, strdup, struct, twoIntsStruct, wchar, destructor, virtual). Top-N sẽ bị skewed: 50 ca đầu tiên là 100% family `char`.

### 4.1.5. Fairness rules

Baseline positive-only (Clang) chỉ enumerate leak finding → TN=0. Vì vậy bỏ specificity/MCC/accuracy khỏi bảng so sánh, chỉ so P/R/F1/FP count/FP/KLOC. Mọi hệ thống dùng cùng `scoreCase` trên cùng corpus.

### 4.1.6. LLM configuration

Model: `mimo/mimo-v2.5-pro`, gateway OpenAI-compatible nội bộ tại port 20128. Temperature: 0 cho judge single, 0.7 cho consensus sampling. Idle-timeout: 75 giây.

---

## 4.2. Ablation 9-baseline capability (headline)

### 4.2.1. Thiết kế

Năm trục độc lập: [static, dynamic, planner, tool_selector, fusion]. Chín baseline B1–B7 khai báo bằng YAML, resolver ánh xạ flags thành engine knobs.

### 4.2.2. Kết quả n=50 stratified

Bảng sau trình bày kết quả trên validated corpus, stratified n=50, single run:

| ID | Baseline | TP | FP | FN | TN | P | R | F1 | ECE | Token |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| B1 | Static only | 42 | 11 | 11 | 146 | 0.792 | 0.792 | 0.792 | 0.548 | 0 |
| B2 | Dynamic only | 35 | 0 | 24 | 0 | 1.000 | 0.593 | 0.745 | 0.041 | 0 |
| B3 | Rule-based ensemble | 48 | 11 | 5 | 146 | 0.814 | 0.906 | 0.857 | 0.161 | 0 |
| B4 | LLM + static | 50 | 18 | 3 | 139 | 0.732 | 0.943 | 0.824 | 0.054 | 1.310.030 |
| B5 | LLM + dynamic | 35 | 0 | 24 | 0 | 1.000 | 0.588 | 0.740 | 0.003 | 37.529 |
| B6 | LLM + all (no planner/sel) | 48 | 1 | 5 | 156 | 0.973 | 0.899 | 0.935 | 0.129 | 455.434 |
| B6a | + planner only | 48 | 1 | 5 | 156 | 0.973 | 0.906 | **0.938** | 0.125 | 463.047 |
| B6b | + tool_selector only | 48 | 2 | 5 | 155 | 0.960 | 0.899 | 0.929 | 0.128 | 4.239.560 |
| B7 | Full adaptive | 48 | 2 | 5 | 155 | 0.960 | 0.899 | 0.929 | 0.130 | 4.115.938 |

Tổng sweep: 10,6 triệu token. Riêng B6b + B7 (agentic) chiếm 8,36 triệu (79%).

### 4.2.3. Đọc bảng

**B6a là winner: F1 0.938, P 0.973, chỉ 463k token.** Kết hợp planner + deterministic recipe + LLM judge cho kết quả tốt nhất trên Juliet.

Thành thật mà nói, kết quả này có phần "buồn" cho phần agentic: `tool_selector` (cho phép model tự chọn tool) tốn gấp 9 lần token nhưng F1 thấp hơn (0.929 vs 0.938). Trên corpus dễ, tính "tự chủ" của agent không những không giúp mà còn gây hại — model lãng phí token vào những cuộc gọi tool không cần thiết.

### 4.2.4. Kết quả n=100

| ID | TP | FP | FN | TN | P | R | F1 |
|---|--:|--:|--:|--:|--:|--:|--:|
| B1 | 78 | 22 | 24 | 289 | 0.780 | 0.765 | 0.772 |
| B3 | 90 | 22 | 12 | 289 | 0.804 | 0.882 | 0.841 |
| B6 | 86 | 0 | 16 | 311 | 1.000 | 0.843 | 0.915 |
| B6a | 89 | 0 | 13 | 311 | 1.000 | 0.873 | **0.932** |
| B7 | 88 | 2 | 14 | 309 | 0.978 | 0.863 | 0.917 |

Ở n=100, B6a đạt P=1.000 hoàn hảo (FP=0). Dynamic + LLM judge hoàn toàn loại bỏ false positive.

---

## 4.3. Ma trận 2×2 (LLM orchestration × Dynamic evidence)

Hai trục phân rã: LLM (no_llm vs llm_assisted) × Dynamic (off vs on). Kết quả trên 30 ca đầu:

| | Static (`--dynamic off`) | + Dynamic |
|---|---|---|
| **no_llm** | TP29 FP7 FN3 · P0.806 R0.906 | TP29–30 FP7 FN2–3 · R0.906–0.938 |
| **llm_assisted** | TP29 FP7 FN3 · P0.806 R0.906 | TP29–30 FP7 FN2–3 · R0.906–0.938 |

Hai phát hiện quan trọng:

**LLM không cải thiện Juliet.** no_llm static ≡ llm_assisted static — cả hai cho TP29 FP7 FN3. Lý do: Juliet produce "non-borderline" bundles, heuristic finalize hết, LLM judge không bao giờ engage.

**Dynamic thêm recall, FP ổn định.** FN 3→2 khi leak path thực sự chạy. FP=7 ở mọi cell — bằng chứng động xác nhận, không tạo FP mới.

Điều này không có nghĩa LLM vô dụng. Trên corpus khó hơn (LAMeD), nơi bundles thực sự borderline và leak là path-sensitive, LLM judge được kỳ vọng phát huy tác dụng.

---

## 4.4. Ablation static evidence tools

Câu hỏi: 11 tool tĩnh, tool nào thật sự cần? Câu trả lời: không phải "cạnh tranh" mà là "bổ sung."

| Static tools | TP | FP | FN | P | R | F1 | ECE |
|---|--:|--:|--:|--:|--:|--:|--:|
| none (candidateScan only) | 42 | 11 | 11 | 0.792 | 0.792 | 0.792 | 0.548 |
| + functionSummary | 42 | 11 | 11 | 0.792 | 0.792 | 0.792 | 0.492 |
| + pathConstraints | 42 | 11 | 11 | 0.792 | 0.792 | 0.792 | 0.503 |
| + both (default) | **50** | **13** | **3** | 0.794 | **0.943** | **0.862** | 0.555 |

Đây là phát hiện đáng chú ý nhất trong ablation: hai tool có tính **synergistic**. Mỗi tool riêng lẻ không cải thiện confusion matrix — nhưng kết hợp lại, recall tăng từ 0.792 lên 0.943 (+8 TP, FN 11→3). Lý do: path-sensitive heuristic cần CẢ function summary (alloc→free pairing scope) lẫn path constraints (guard reconciliation) để fire.

---

## 4.5. Đánh giá trên LAMeD — dự án thực

### 4.5.1. Static parity

Trên 41 ca LAMeD với cấu hình mặc định (2 tool enrich, allocator profile per-case từ manifest):

| Cấu hình | TP | FP | Recall | Precision |
|---|--:|--:|--:|--:|
| default (functionSummary + pathConstraints) | 11 | 0 | 0.250 | 1.000 |
| + interproceduralFlow | **12** | 0 | **0.273** | 1.000 |

So với Clang Static Analyzer: TP=0 trên 43 ca (recall 0.000).

**12 leak bắt được, FP=0. Clang bắt 0.** Phân bố: curl 5/16, libtiff 1/7, rabbitmq-c 1/2, +1 từ interproceduralFlow (cjson merge_patch).

### 4.5.2. Case study: cjson merge_patch

Leak đầu tiên bắt được trên dự án thực. Hàm `cJSON_merge_patch` nhận tham số `target`, giải phóng trên đường thành công nhưng không trên đường lỗi. Guard-subset reconciliation phát hiện `cJSON_Delete(target)` nằm trên nhánh return khác → feasible leak path. Parameter-ownership term trong heuristic judge flag là confirmed leak.

Đây là minh chứng end-to-end: từ candidate scan (phát hiện factory allocator), qua static enrichment (path-sensitive analysis), đến judge (parameter-ownership scoring).

### 4.5.3. Phân tích 6 leak classes cjson

Đọc trực tiếp từ 6 fix-commit:

1. **Deallocator-semantics:** `cJSON_Duplicate` buffer `cJSON_strdup` gắn cờ `cJSON_StringIsConst` → `cJSON_Delete` bỏ qua không free. Cần mô hình hoá ngữ nghĩa deallocator.
2. **Deallocator-semantics:** `cJSON_ReplaceItemInObject` tương tự.
3. **Path-sensitive:** `merge_patch` thiếu `cJSON_Delete(target)` trên đường lỗi. Lớp DUY NHÁT có hi vọng bắt bằng path analysis.
4. **Path-sensitive:** `FindPointer` thiếu `cJSON_free(full_pointer)` trên đường lỗi.
5. **Control-flow:** `suffix_object` reorder + null-guard trước alloc — tinh vi.
6. **File-level:** leak trong setup/teardown test.

Kết luận: 32 FN còn lại phần lớn cần phân tích sâu hơn (deallocator semantics, alias-aware interprocedural dataflow) — không phải thiếu tool mà là thiếu chiều phân tích.

---

## 4.6. Ablation consensus judge

### 4.6.1. Verdict stability

Cùng 30 ca, cùng analyzer, hai lần chạy mỗi nhánh. Hai đợt đo (campaign A và B, sau khi siết tương quan dynamic↔candidate):

| Judge arm | Campaign | Case stability | Flip rate | Modal agreement |
|---|---|---|---|---|
| single-LLM (K=1) | A | 73.3% | 26.7% (8/30) | 86.7% |
| single-LLM (K=1) | B | 86.7% | 13.3% (4/30) | 93.3% |
| consensus (K=3) | A | 93.3% | 6.7% (2/30) | 96.7% |
| consensus (K=3) | B | 93.3% | 6.7% (2/30) | 96.7% |

Điều đáng nói: consensus arm lặp lại Y HỆT qua hai campaign (6.7% / 93.3% / 96.7% cả hai lần). Đây là tính chất ổn định, không phải số may mắn. Ngược lại, single-LLM flip rate tự nó dao động (26.7% rồi 13.3%) — sự bất ổn của chính nó là thêm bằng chứng cho vấn đề consensus nhắm giải quyết.

### 4.6.2. McNemar test

Campaign B, 77 sites, single vs consensus: consensus acc 83.1% / F1 0.822, single acc 79.2% / F1 0.784. Trong các site bất đồng, 5 nghiêng về consensus, 2 nghiêng về single. χ²=0.57, **p=0.45** — chưa có ý nghĩa thống kê ở n=30.

Thành thật: quá ít cặp bất đồng để reject "no difference." Kết quả là xu hướng + CI, cần multi-seed hoặc corpus khó hơn trước khi khẳng định "consensus thắng" theo paired test.

---

## 4.7. So sánh với baseline bên ngoài

### 4.7.1. Juliet n=30

| Hệ thống | TP | FP | FN | TN | P | R | F1 | FP/KLOC |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| no_llm (heuristic) | 29 | 7 | 3 | 38 | 0.806 | 0.906 | **0.853** | **0.741** |
| consensus (K=3) | 30 | 10 | 2 | 35 | 0.750 | 0.938 | 0.833 | 1.058 |
| clang-analyzer | 27 | 12 | 5 | 0 | 0.692 | 0.844 | 0.761 | 1.270 |

Cả hai cấu hình thắng Clang về F1. FP/KLOC thấp hơn.

### 4.7.2. LAMeD

| Hệ thống | TP | FP | Recall | Precision |
|---|--:|--:|--:|--:|
| leak-investigator (static) | 12 | 0 | 0.273 | 1.000 |
| clang-analyzer | 0 | 0 | 0.000 | — |

Nằm trong dải LAMeD tự báo cho công cụ có annotation (5–10/43). Clang raw = 0 vì `unix.Malloc` không mô hình hoá factory allocator.

### 4.7.3. So sánh với các hệ thống LLM khác

Bảng sau so sánh leak-count với các hệ thống dùng LLM cho leak C/C++. Lưu ý: so sánh chỉ mang tính tham khảo vì corpus khác nhau — không dùng để kết luận hệ thống nào "tốt hơn."

| Hệ thống | Corpus | Leak found | Method | Peer-review |
|---|---|--:|---|:--:|
| MemHint [20] | 8 dự án C/C++ (3.6M LOC) | 52–54 | LLM + Z3 + CodeQL/Infer | ❌ |
| LAMeD [21] (Cooddy+annotation) | cJSON + 6 dự án | 28 TP / 2 FP | LLM annotation → Cooddy | ✅ |
| LAMeD [21] (CodeQL+annotation) | 6 dự án thực | 5→10 | LLM annotation → CodeQL | ✅ |
| Hệ thống (static) | LAMeD 41 ca | 12 | LLM orchestration + heuristic | — |
| Hệ thống (static) | Juliet 1658 ca | 48/53 TP | LLM orchestration + heuristic | — |

MemHint [20] đạt leak-count cao nhất (52–54) nhưng trên corpus lớn hơn nhiều (8 dự án, 3.6M LOC) và chưa peer-review. Điểm chung: cả MemHint và luận văn đều cần LLM khám phá allocator — MemHint dùng LLM phân loại hàm, luận văn dùng LLM profiler với grep-verify.

LAMeD [21] đạt P=0.933/R=0.583 trên cJSON khi dùng Cooddy. So với luận văn trên cùng cJSON: luận văn bắt 0/6 leak cJSON ở cấu hình mặc định (sau nâng cấp allocator-aware bắt được 1/6 qua interproceduralFlow). Khoảng cách này chủ yếu do Cooddy có annotation chi tiết hơn (AllocSource/FreeSink function-level) so với allocator set đơn giản hơn của luận văn. Đây chính là động lực cho tầng LLM allocator profiler.

---

## 4.8. Xác minh tái lập

### 4.8.1. Tier-1

Hai lần chạy no_llm (thư mục tách biệt, cùng cấu hình): TP29 FP7 FN3 TN38 y hệt. Gate `determinism-gate.sh` PASS.

### 4.8.2. Tier-2

B6a, 3 runs: F1 mean 0.935 ± 0.020 (min 0.913, max 0.950), P mean 0.973 ± 0.031, R mean 0.899 ± 0.011. B7, 3 runs: F1 mean 0.938 ± 0.015.

Variance nhỏ — LLM judge đủ ổn định cho practical use, nhưng không đủ cho bitwise reproducibility claim.

---

## 4.9. Độ chính xác LLM allocator profiling

Chạy `validate-allocator-profile.ts` trên cjson với mimo local temp 0:

- **Allocator Recall 85%** — LLM phát hiện hầu hết tên hàm cấp phát.
- **Deallocator Recall 100%** — không bỏ sót tên hàm giải phóng nào.

Điều thú vị: phần lớn "false positive" của profiler thực ra là allocator thật mà list hardcode bỏ sót — `cJSON_Parse()`, `cJSON_Print()` trả owned memory. Nghĩa là LLM đầy đủ hơn list người viết tay.

Ownership notes cũng chính xác: ví dụ `cJSONUtils_FindPointerFromObjectTo` trả chuỗi freed bằng `cJSON_free`.

---

## 4.10. Tổng hợp chương

### Bảng tổng hợp toàn bộ kết quả

| Corpus | Cấu hình tốt nhất | F1 | P | R | Ghi chú |
|---|---|---|---|---|---|
| Juliet n=50 | B6a | 0.938 | 0.973 | 0.906 | Winner, 463k tok |
| Juliet n=100 | B6a | 0.932 | 1.000 | 0.873 | FP=0 |
| LAMeD (static) | +interprocFlow | 0.429 | 1.000 | 0.273 | vs Clang 0/43 |
| Consensus K=3 | ablation | — | — | — | Flip 6.7% vs 26.7% |

Ba kết luận rút ra: (1) Dynamic là "FP killer" — thêm dynamic giảm FP từ 18 xuống 1; (2) Agentic tool_selector counter-productive trên corpus dễ — 9× chi phí cho F1 thấp hơn; (3) Consensus giảm dao động verdict 2–4×, replicated qua hai campaign.

### Điều kiện nào LLM orchestration có lợi?

Từ kết quả trên hai corpus, có thể rút ra ba điều kiện:

**Corpus khó, bundle borderline.** Trên Juliet (dễ), heuristic finalize hết → LLM judge không engage → no_llm ≡ llm_assisted. Trên LAMeD (khó), leak là path-sensitive + interprocedural → heuristic không đủ → LLM judge + consensus có đất phát huy.

**Cần cross-function reasoning.** interproceduralFlow Δ=0 trên Juliet (intra-function leak) nhưng +1 TP trên LAMeD (cjson merge_patch cross-function). LLM orchestration hữu ích khi leak vắt qua biên hàm mà heuristic per-function không thấy.

**Chi phí phải được kiểm soát.** B6a (463k token) là sweet spot trên Juliet. Agentic (4.2M token) chỉ có lợi khi exploration thật sự cần thiết — trên Juliet, nó lãng phí. Câu hỏi mở cho corpus khó hơn: agentic exploration có bù đắp được chi phí?
