# Chương 4: Đánh giá kết quả

Mọi thiết kế đều là giả thuyết cho đến khi được kiểm chứng bằng thực nghiệm. Chương này trình bày kết quả đánh giá trên ba corpus: Juliet CWE-401 (corpus synthetic, 1658 ca), LAMeD benchmark (corpus dự án thực, 41 ca) và MemHint (corpus dự án thực tự tái lập, 19 ca), với các ablation study phân rã đóng góp từng thành phần. Số liệu được báo cáo trung thực, kể cả khi chúng không như kỳ vọng.

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

Các run chốt của luận văn dùng model `deepseek-v4-flash` qua gateway OpenAI-compatible (`openai-compat`) nội bộ tại port 20128. Cụ thể: sweep full-corpus 1658 ca (mục 4.2, commit `5eec8b1`), bộ run LAMeD 2026-08-20 (mục 4.5), ablation consensus n=50 (mục 4.6) và validation allocator-profile (mục 4.9). Temperature 0 cho judge single, 0.7 cho consensus sampling. Idle-timeout: 75 giây.

Không phải mọi thí nghiệm đều dùng một model, và chúng tôi ghi rõ model của từng run thay vì gộp chung. Bảng n=50 stratified ở mục 4.2.3 là thí nghiệm đầu (2026-06), đo trên `mimo/mimo-v2.5-pro`, sau đó re-measure trên corpus đã validate. Hai sweep phụ cấu hình B6a trên full corpus dùng model khác để kiểm tra tính tổng quát: `mimo-v2.5` cho F1 0.737, `glm-5.2` (z-ai) cho F1 0.774 (run 1/2 hoàn tất, số derive từ per-case rows). Cùng cấu hình B6a trên cùng corpus `f578c3ee`, F1 dao động từ 0.737 đến 0.863 theo model: cấu hình không được "tune" theo một model duy nhất, nhưng mức F1 tuyệt đối thì phụ thuộc model. Chi phí giữa các provider không so sánh trực tiếp được với nhau.

---

## 4.2. Ablation 9-baseline capability (headline)

### 4.2.1. Thiết kế

Năm trục độc lập: [static, dynamic, planner, tool_selector, fusion]. Chín baseline B1–B7 khai báo bằng YAML, resolver ánh xạ flags thành engine knobs.

### 4.2.2. Kết quả full-corpus 1658 ca (headline)

Sweep 9 baseline trên toàn bộ corpus 1658 ca, commit `5eec8b1`, model `deepseek-v4-flash`, chạy trên WSL2 với `--concurrency 16`. Các baseline dùng LLM (B4 đến B7) chạy 3 lần để đo mean ± std; hai run riêng lẻ (B6b/run-2 và B7/run-3) từng bị nhiễm lỗi fallback-judge im lặng, được phát hiện và chạy lại trước khi tính vào bảng. Bảng sau là kết quả gộp:

| ID | Baseline | TP | FP | FN | TN | P | R | F1 | F1 (95% CI) | tok/case | Chi phí |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| B1 | Static only | 1433 | 674 | 1145 | 2785 | 0.680 | 0.556 | 0.612 | 0.612 [0.596, 0.628] | 0 | — |
| B2 | Dynamic only | 735 | 0 | 2283 | 0 | 1.000 | 0.244 | 0.392 | 0.392 [0.372, 0.410] | 0 | — |
| B3 | Rule-based ensemble | 1686 | 674 | 892 | 2785 | 0.714 | 0.654 | 0.683 | 0.683 [0.668, 0.698] | 0 | — |
| B4 | LLM + static | 2035 | 470 | 543 | 2989 | 0.812 | 0.789 | 0.801 ± 0.001 | 0.800 [0.789, 0.812] | 9.947 | $9.69 |
| B5 | LLM + dynamic | 735 | 0 | 2282 | 0 | 1.000 | 0.244 | 0.392 ± 0.005 | 0.393 [0.373, 0.412] | 303 | $0.26 |
| B6 | LLM + all (no planner/sel) | 2009 | 74 | 569 | 3390 | 0.964 | 0.779 | 0.862 ± 0.001 | 0.862 [0.852, 0.872] | 5.513 | $5.99 |
| B6a | + planner only | 2010 | 72 | 568 | 3392 | 0.965 | 0.780 | **0.863 ± 0.001** | 0.864 [0.854, 0.874] | 6.155 | $6.63 |
| B6b | + tool_selector only | 2017 | 104 | 561 | 3360 | 0.951 | 0.782 | 0.858 ± 0.003 | 0.855 [0.844, 0.865] | 30.590 | $26.07 |
| B7 | Full adaptive | 2004 | 101 | 574 | 3363 | 0.952 | 0.777 | 0.856 ± 0.002 | 0.856 [0.845, 0.866] | 32.004 | $27.14 |

Khoảng tin cậy 95% của F1 tính bằng site-level percentile bootstrap trên per-site samples (1.000 resamples, seed `0xc0ffee`); cấu hình đa-run lấy run-1. Riêng B6b: điểm CI run-1 (0.855) thấp hơn trung bình 3-run đang in (0.858 ± 0.003) một khoảng ≈1 độ lệch run-to-run — ghi rõ để người đọc không đọc nhầm là bất nhất. Code: `runBaselineEval.ts`; artifact: `results/baseline-sweep-2026-08-15T08-28-06/`.

Tổng chi phí sweep: $75.78 (B1, B2, B3 là `no_llm`, không định giá). MCC của B6a là 0.790, lấy làm mean của 3 run từ `variance.json`. Thứ hạng F1: B6a 0.863 ≈ B6 0.862 > B6b 0.858 ≈ B7 0.856 > B4 0.801 > B3 0.683 > B1 0.612 > B5 0.392 ≈ B2 0.392.

Ba điều đáng đọc từ bảng. Thứ nhất, cùng sweep, cùng commit: B6a 0.863 so với B1 static-only 0.612, tức trên full corpus judge LLM thực sự giúp. Thứ hai, chi phí: B7 agentic tốn $27.14, khoảng 4 lần B6a ($6.63), để đạt F1 thấp hơn; tính trên token thì 32k/case so với 6.2k/case, khoảng 5 lần. Thứ ba, dynamic evidence tiếp tục là nguồn giảm FP mạnh nhất ở quy mô lớn: B4 (LLM + static, không dynamic) tạo 470 FP, thêm dynamic (B6) giảm FP 470→74 với F1 cao hơn. Kết luận rút ra ở n=50 vì thế tái lập trên corpus lớn gấp 33 lần, với model khác.

### 4.2.3. Kết quả n=50 stratified (thí nghiệm đầu, giữ làm phụ)

Bảng dưới là thí nghiệm đầu của chuỗi ablation (2026-06), chạy trên model `mimo/mimo-v2.5-pro`, stratified n=50, single run (mean 3 runs của B6a: F1 0.938±0.015, xem mục 4.8.2). Chúng tôi giữ nguyên làm dữ liệu phụ; câu chuyện đầy đủ về hai bộ số nằm ở mục 4.2.5.

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

Cột ECE của bảng trên cần đọc đúng nghĩa. Confidence của tầng heuristic không phải xác suất được hiệu chuẩn: ECE 0.548 của B1 cho thấy khoảng cách lớn giữa giá trị confidence và độ chính xác thực tế. Các giá trị confidence vì thế chỉ dùng nội bộ để xếp hạng candidate và so ngưỡng, không nên ngoại suy thành độ tin cậy bên ngoài; hiệu chuẩn lại (Platt scaling hoặc isotonic trên dữ liệu held-out) là hướng phát triển.

### 4.2.4. Kết quả n=100

Từ cùng đợt thí nghiệm đầu (model `mimo/mimo-v2.5-pro`), mở rộng n=100, chỉ chạy các cấu hình không agentic:

| ID | TP | FP | FN | TN | P | R | F1 |
|---|--:|--:|--:|--:|--:|--:|--:|
| B1 | 78 | 22 | 24 | 289 | 0.780 | 0.765 | 0.772 |
| B3 | 90 | 22 | 12 | 289 | 0.804 | 0.882 | 0.841 |
| B6 | 86 | 0 | 16 | 311 | 1.000 | 0.843 | 0.915 |
| B6a | 89 | 0 | 13 | 311 | 1.000 | 0.873 | **0.932** |
| B7 | 88 | 2 | 14 | 309 | 0.978 | 0.863 | 0.917 |

Ở n=100, B6a đạt P=1.000 hoàn hảo (FP=0). Dynamic + LLM judge hoàn toàn loại bỏ false positive.

### 4.2.5. Hòa giải: stratified 0.938 so với full-corpus 0.863

Cùng cấu hình B6a, cùng corpus hash `f578c3ee`, mà F1 chênh 0.075 (0.938±0.015 ở n=50 stratified so với 0.863±0.001 ở full corpus). Khác ở đâu? Không phải ở model hay cấu hình, mà ở cách lấy mẫu. Mẫu stratified round-robin bốc đều 10 families, trong khi corpus thật bị lệch hẳn về họ C++ `new`: 588/1658 ca (35%), gấp đôi họ lớn kế tiếp. Kết quả full-corpus vì thế chịu ảnh hưởng của họ khó nhất nhiều hơn tỷ trọng mà mẫu cân bằng phản ánh.

Phân rã theo family trong sweep full-corpus cho thấy khoảng cách này là thật, không phải nhiễu. Với B6a, theo từng run (`byFunctionalVariant`): family `malloc` đạt F1 0.991 ở run tốt nhất (mean 3 run: 0.975), còn `strdup` chỉ đạt 0.584 (mean: 0.576). Một cấu hình có thể gần như hoàn hảo trên một family và kém hơn 0.4 điểm F1 trên family khác; mỗi sample nhỏ 50 ca đều qua round-robin chỉ chứa ~5 ca mỗi family, nên hiệu ứng family bị pha loãng. Std ±0.015 của B6a ở n=50 so với ±0.001 ở full corpus cũng là tín hiệu cùng chuyện: biến động đến từ thành phần mẫu, không từ run LLM.

Cả hai con số đều đúng, chúng chỉ trả lời hai câu hỏi khác nhau. 0.863 là hiệu năng trên toàn corpus, con số nên dùng khi nói về hệ thống nói chung. 0.938 là ablation cấu phần trên mẫu cân bằng family, hợp lý khi so sánh tương đối giữa các cấu hình. Bài học phương pháp luận: sample stratified nhỏ làm kết quả LLM-judge trông tốt hơn trên corpus lệch family, và mọi so sánh cần ghi rõ cách lấy mẫu.

### 4.2.6. Độ nhạy ngưỡng chấm điểm

Mọi số liệu ở trên dùng đúng một ngưỡng ra quyết định. Để đo mức phụ thuộc vào ngưỡng, chúng tôi re-threshold offline giá trị `confidence` đã lưu trên các verdict của sweep baseline: một finding bị flag nhưng có `confidence < c` bị hạ thành `false_positive`, sau đó toàn bộ 1658 ca được chấm lại bằng chính scorer production (`scoreCase` + `computeMetrics`), với `c` chạy 0.0 → 1.0 bước 0.1 (script `scripts/threshold-sweep.ts`, kết quả đầy đủ trong `paper/figures/threshold-sweep.csv`; artifact `results/baseline-sweep-2026-08-15T08-28-06/`). Các hàng chọn lọc:

| Config | c = 0.0 | c = 0.3 | c = 0.5 | c = 0.7 | c = 0.9 |
|---|---|---|---|---|---|
| B1 — F1 | 0.612 | 0.612 | 0.612 | 0.000 | 0.000 |
| B6a — F1 | 0.864 | 0.864 | 0.864 | 0.809 | 0.781 |
| B6a — Precision | 0.968 | 0.968 | 0.968 | 0.990 | 0.989 |
| B6a — Recall | 0.780 | 0.780 | 0.780 | 0.684 | 0.645 |

Script tự kiểm chứng chống fabrication: tại c = 0.0 phép biến đổi là no-op (vì `scoreCase` suy ra `predicted` từ `isFlagged(verdict)`), và hàng c = 0.0 phải khớp `overall` trong `metrics.json` đã lưu của từng cấu hình — B1 0.612, B6a 0.864, B6 0.862, sai số 0; script assert điều này mỗi lần chạy và từ chối ghi CSV nếu lệch.

Hai giới hạn cần nói thẳng. Thứ nhất, đây là **phân tích offline**: re-thresholding độ tin cậy trên các verdict đã-lưu của sweep, không phải chạy lại hệ thống; confidence là đại lượng theo hướng verdict (finding "chắc chắn sạch" cũng có confidence cao), nên đường cong này đo độ phân tách của confidence trên prediction đã đóng băng, không đo lại quá trình chấm điểm.

Thứ hai, quét ngưỡng điểm nội bộ 0.7/0.4 của heuristic judge là bất khả-thi offline vì điểm thô của từng tín hiệu không được lưu trong artifact — đây là future work, cùng với leave-one-signal-out trên 11 tín hiệu của heuristic judge (bảng 2.7.1).

Đọc số liệu: B1 (heuristic, `no_llm`) gán confidence phẳng 0.5 cho mọi finding, nên mọi c > 0.5 xóa sạch toàn bộ prediction (F1 = 0) — re-thresholding vô nghĩa với judge tất định. B6a giữ nguyên F1 đến c = 0.5 rồi giảm đơn điệu (0.864 → 0.809 tại c = 0.7 → 0.781 tại c = 0.9, precision tăng nhẹ): F1 đạt đỉnh đúng tại chế độ production, tức confidence đã lưu không mang thêm dải phân biệt nào phía trên ngưỡng hiện hành — không coi nó là núm hiệu chỉnh có thể xoay sau khi verdict đã chốt.

---

## 4.3. Ma trận 2×2 (LLM orchestration × Dynamic evidence)

Hai trục phân rã: LLM (no_llm vs llm_assisted) × Dynamic (off vs on). Kết quả trên 30 ca đầu (cùng một mẫu đơn-family như mục 4.6.1; kết quả chỉ mang tính định hướng, không khái quát):

| | Static (`--dynamic off`) | + Dynamic |
|---|---|---|
| **no_llm** | TP29 FP7 FN3 · P0.806 R0.906 | TP29–30 FP7 FN2–3 · R0.906–0.938 |
| **llm_assisted** | TP29 FP7 FN3 · P0.806 R0.906 | TP29–30 FP7 FN2–3 · R0.906–0.938 |

Hai phát hiện quan trọng:

**LLM không cải thiện Juliet.** no_llm static ≡ llm_assisted static — cả hai cho TP29 FP7 FN3. Lý do: Juliet produce "non-borderline" bundles, heuristic finalize hết, LLM judge không bao giờ engage.

**Dynamic thêm recall, FP ổn định.** FN 3→2 khi leak path thực sự chạy. FP=7 ở mọi cell — bằng chứng động xác nhận, không tạo FP mới.

Điều này không có nghĩa LLM vô dụng. Trên Juliet, điểm khác biệt nằm ở tầng enrichment cộng judge: cấu hình LLM tốt nhất (B6a 0.863 full corpus) hơn hẳn static-only B1 (0.612) trong cùng sweep. Còn LLM judge có lật được verdict trên dự án thực hay không, mục 4.5 trả lời bằng số liệu đo được, không phải kỳ vọng.

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

### 4.5.1. Kết quả trên denominator 50 site (bộ run 2026-08-20)

Số liệu dưới đây từ bộ run 2026-08-20, sau khi sửa một lỗi đếm site: `computeBundleId` cũ dùng pseudo-hash cắt cụt, gộp các candidate khác nhau thành một, làm thiếu cả recall lẫn denominator. Sau fix, corpus LAMeD cho 50 site chấm được (trước đây 44: libsolv 6→11 site, cjson 6→7, 5 dự án còn lại không đổi).

| Cấu hình | TP | FP | FN | Recall | Precision |
|---|--:|--:|--:|--:|--:|
| Clang Static Analyzer (43 site) | 0 | 0 | 43 | 0.000 | — |
| `no_llm` mặc định (50 site) | **15** | 0 | 35 | **0.300** | 1.000 |
| `no_llm` + `interproceduralFlow` | **15** | 0 | 35 | **0.300** | 1.000 |
| `llm_assisted` (mean 3 runs, std = 0) | **15** | 0 | 35 | **0.300** | 1.000 |

**15 leak bắt được, FP=0, Clang bắt 0.** Ba cấu hình của hệ thống cho confusion matrix giống hệt nhau, và điều đó nói lên hai điều. Một, `interproceduralFlow` không thêm giá trị đo được trên benchmark này: run mặc định và run +`interproceduralFlow` byte-identical trên cả 41 ca. Nguyên nhân đã được root-cause bằng lời gọi cô lập trực tiếp tới tool trên ca `merge_patch`: nó đếm được hai call site `cJSON_Delete(target)` reachable từ hàm và kết luận allocation đã được free, mà không kiểm tra hai free đó nằm trên hai nhánh loại trừ lẫn nhau (bug thật nằm ở nhánh lỗi thứ ba, không free nhánh nào). Đây là lỗ hổng path-insensitivity trong chính phép đếm alloc/free của tool, cùng lớp giới hạn với guard-subset reconciliation của judge nhưng nằm sớm hơn một tầng. Hai, `llm_assisted` cho kết quả y hệt `no_llm`: judge LLM (`deepseek-v4-flash`, temp 0) thực sự được gọi từ 47 đến 149 lần mỗi run trên các bundle heuristic đánh dấu borderline, nhưng không lật verdict nào. Telemetry judge-path xác nhận LLM có chạy thật, không phải bị bỏ qua. Phù hợp với phát hiện ở Juliet: đòn bẩy chính của lớp leak này là dynamic evidence, không phải judging.

Về denominator 43 so với 50: hai hàng không dùng chung mẫu số, và đó là thiết kế của scorer chứ không phải lỗi. `scoreCase` suy ra tập site chấm được từ chính finding granularity của tool đang được chấm, nên site count là thuộc tính của từng tool, không phải ground truth ngoài chung cho mọi tool. Chi tiết lập luận nằm ở `results/lamed-correction-2026-08-20-README.md`, mục 4.

### 4.5.2. Case study: cjson merge_patch

`cJSON_merge_patch` nhận tham số `target`, giải phóng trên đường thành công nhưng không trên đường lỗi. Đây là archetype của lớp leak path-sensitive + parameter-ownership mà heuristic judge nhắm tới: guard-subset reconciliation được thiết kế để phát hiện một free chỉ cover exit path khi tập guard condition của free đó là tập con của guard set trên đường exit. Trong bộ run 2026-08-20, ca này hiện là FN: như phân tích ở trên, `interproceduralFlow` kết luận "balanced" vì đếm đủ hai call site free mà không soi tính loại trừ của nhánh. Một phép đo trước đó trên denominator 44 site (trước fix `computeBundleId`) từng ghi +1 TP cho `interproceduralFlow` trên chính ca này (recall 0.250 → 0.273); phát hiện đó đã bị thu hồi sau khi verify cô lập như trên. Case study này vì thế giữ giá trị ở vai trò minh hoạ giới hạn: điểm yếu của tầng phân tích cross-function hiện tại không phải là "chưa gọi tool" mà là tool đếm alloc/free không path-sensitive.

### 4.5.3. Phân tích 6 leak classes cjson

Đọc trực tiếp từ 6 fix-commit:

1. **Deallocator-semantics:** `cJSON_Duplicate` buffer `cJSON_strdup` gắn cờ `cJSON_StringIsConst` → `cJSON_Delete` bỏ qua không free. Cần mô hình hoá ngữ nghĩa deallocator.
2. **Deallocator-semantics:** `cJSON_ReplaceItemInObject` tương tự.
3. **Path-sensitive:** `merge_patch` thiếu `cJSON_Delete(target)` trên đường lỗi. Lớp DUY NHÁT có hi vọng bắt bằng path analysis.
4. **Path-sensitive:** `FindPointer` thiếu `cJSON_free(full_pointer)` trên đường lỗi.
5. **Control-flow:** `suffix_object` reorder + null-guard trước alloc — tinh vi.
6. **File-level:** leak trong setup/teardown test.

Sáu ca gộp thành bốn lớp cấu trúc khác nhau: deallocator semantics, path-sensitivity, control-flow reordering, và code file/test-only. 35 FN còn lại trên 50 site không quy về một thành phần yếu duy nhất, mà là thiếu chiều phân tích (deallocator semantics, interprocedural dataflow alias-aware). Cùng kết luận mà LAMeD tự báo: ngay cả các tool tiên tiến nhất cũng chỉ bắt 5-10/43 leak thật trong đánh giá của họ.

---

## 4.6. Ablation consensus judge

### 4.6.1. Thí nghiệm đầu: n=30

Chúng tôi kể theo đúng trình tự thí nghiệm đã chạy, kể cả khi kết quả cuối đi ngược kết quả đầu. Đợt đo đầu tiên dùng 30 ca đầu của corpus, tức 100% một family duy nhất (`char`, xem mục 4.2.5), với hai nhánh single-LLM (K=1) và consensus (K=3), hai lần chạy mỗi nhánh, lặp lại hai campaign A/B:

| Judge arm | Campaign | Case stability | Flip rate | Modal agreement |
|---|---|---|---|---|
| single-LLM (K=1) | A | 73.3% | 26.7% (8/30) | 86.7% |
| single-LLM (K=1) | B | 86.7% | 13.3% (4/30) | 93.3% |
| consensus (K=3) | A | 93.3% | 6.7% (2/30) | 96.7% |
| consensus (K=3) | B | 93.3% | 6.7% (2/30) | 96.7% |

Tại thời điểm đó, kết quả trông rất rõ: consensus arm lặp lại y hệt qua hai campaign (6.7% / 96.7% cả hai lần), single-LLM flip rate dao động 26.7% rồi 13.3%. McNemar trên 77 site của campaign B cũng nghiêng về consensus: consensus acc 83.1% / F1 0.822 so với single 79.2% / 0.784, 5 nghiêng consensus so với 2 nghiêng single, χ²=0.57, p=0.45. Chưa có ý nghĩa thống kê ở n=30, nhưng xu hướng thì một chiều.

### 4.6.2. Đo lại trên mẫu stratified n=50: kết quả đảo ngược

Bài học từ mục 4.2.5 khiến chúng tôi nghi ngờ chính mẫu n=30. Đo lại trên n=50 stratified round-robin (2 runs mỗi nhánh, model `deepseek-v4-flash`, commit `f0d371c`), 205 site chấm được. Hai campaign cho cùng một chiều kết quả, flip rate lặp lại y hệt:

| Judge arm | Flip rate | F1 |
|---|---|---|
| single-LLM (K=1) | **2.0%** | 0.852 |
| consensus (K=3) | 8.0% | 0.793 |

Mọi thứ đảo chiều so với n=30. Single-LLM nay là nhánh ổn định hơn (flip 2.0% so với 8.0%) và chính xác hơn (F1 0.852 so với 0.793), nhất quán ở cả hai campaign. McNemar paired trên 205 site: trong các site bất đồng, đa số nghiêng về single-LLM; χ²=3.13, p=0.077, xu hướng lean single nhưng chưa đạt ngưỡng ý nghĩa thống kê ở quy mô này.

### 4.6.3. Vì sao kết quả đầu sai, và kết luận

Hai phép đo đó không mâu thuẫn nhau; chúng đo hai mẫu khác nhau. Mẫu n=30 đầu (100% family `char`) là corpus dễ, nơi consensus sampling ở temp 0.7 có lợi thế; khi mức khó được phân bố đều qua 10 families, các ca khó thật (như family `strdup` với F1 0.584 ở mục 4.2.5) phơi bày điểm yếu của consensus: phiếu LLM trên ca khó không độc lập, và đa số phiếu có thể bầu cho sai một cách có hệ thống. Flip rate của single-LLM ở n=30 (từ 13.3% đến 26.7%) cũng không tái lập ở n=50 stratified (2.0%): phần lớn "bất ổn" trước đó là hiệu ứng family-dễ, không phải tính chất của judge.

Kết luận chính thức của luận văn: **consensus không được khuyến nghị làm mặc định**. Trên bằng chứng tốt nhất hiện có (mẫu đại diện phân bố khó, n=50, paired test 205 site), consensus vừa kém ổn định hơn vừa kém chính xác hơn single-LLM, chênh lệch chưa đạt ý nghĩa thống kê (p=0.077). Cơ chế vẫn giữ lại như tuỳ chọn opt-in (`consensus.n > 1`) chờ nghiên cứu multi-seed trên quy mô lớn hơn. Đây là kết quả âm tính có chủ đích: cơ chế nằm trong tên đề tài, được đánh giá nghiêm túc, và bị từ chối bởi chính giao thức đánh giá của luận văn.

---

## 4.7. So sánh với baseline bên ngoài

### 4.7.1. Juliet n=30 (live re-run, cùng scorer)

Bảng so sánh trực tiếp trên 30 ca đầu (thí nghiệm sớm, cùng một mẫu đơn-family như mục 4.6.1), chạy lại cả hai hệ trên cùng scorer:

| Hệ thống | Sites | TP | FP | FN | TN | P | R | F1 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| no_llm (heuristic) | 77 | 29 | 7 | 3 | 38 | 0.806 | 0.906 | **0.853** |
| clang-analyzer | 44 | 27 | 12 | 5 | 0 | 0.692 | 0.844 | 0.761 |

Chú thích về cột "Sites": đây là số site cấp phát chấm được trên 30 ca đó (mỗi ca có thể chứa nhiều site), không phải một số ca thứ hai. Output của Clang Static Analyzer (chỉ warning, không có clearance per-site tường minh) tạo ra một tập site nhỏ hơn và không trùng; TN=0 của hàng Clang là cấu trúc đặc trưng của công cụ positive-only. Trên mẫu này, cấu hình heuristic thắng Clang về cả F1 lẫn mật độ FP. So sánh ở quy mô full corpus nằm ở bảng mục 4.2.2.

### 4.7.2. LAMeD

| Hệ thống | Sites | TP | FP | Recall | Precision |
|---|--:|--:|--:|--:|--:|
| Hệ thống (no_llm = llm_assisted) | 50 | 15 | 0 | 0.300 | 1.000 |
| clang-analyzer | 43 | 0 | 0 | 0.000 | — |

Recall 30.0% với FP=0 nằm trong dải LAMeD tự báo cho các công cụ có annotation (5-10/43 leak). Clang raw = 0 vì `unix.Malloc` không mô hình hoá factory allocator. Chênh lệch denominator 43 so với 50 là by-design của scorer (mỗi hệ được chấm trên tập site do chính finding granularity của nó suy ra), đã phân tích ở mục 4.5.1 và chi tiết tại `results/lamed-correction-2026-08-20-README.md`, mục 4.

### 4.7.3. So sánh với các hệ thống LLM khác

Bảng sau so leak-count với các hệ thống dùng LLM cho leak C/C++. Lưu ý: corpus và giao thức chấm khác nhau, nên so sánh chỉ mang tính định hướng, không dùng để kết luận hệ thống nào "tốt hơn."

| Hệ thống | Corpus | Kết quả | Phương pháp | Peer-review |
|---|---|---|---|:--:|
| MemHint [20] | 7 dự án thực, 3.4M+ SLOC | 52–54 leak tìm thấy (49 confirmed/fixed, 4 CVE) | LLM + Z3 + CodeQL/Infer | Không |
| LAMeD [21] (annotation) | cJSON, 152 hàm | P 0.933 / R 0.583 (28 TP / 2 FP / 20 FN) | LLM sinh AllocSource/FreeSink annotation | Có |
| LAMeD [21] (Cooddy) | 6 dự án thực, 43 leak | 5→10 phát hiện | Cooddy tiêu thụ annotation | Có |
| LAMeD [21] (CodeQL) | 6 dự án thực, 43 leak | 5→10 phát hiện | CodeQL tiêu thụ annotation | Có |
| Hệ thống luận văn | LAMeD, 41 ca (50 site) | 15 TP / 0 FP | `no_llm` và `llm_assisted` cho kết quả như nhau | — |
| Hệ thống luận văn | Juliet, full corpus 1658 ca | 2010 TP / 72 FP (B6a) | LLM orchestration + static + dynamic | — |

MemHint [20] đạt leak-count cao nhất (52–54, 49 confirmed/fixed) nhưng trên corpus lớn hơn nhiều (7 dự án, 3.4M+ SLOC) và chưa qua peer-review. Bảng dùng số tự báo bản v3 của paper (7 dự án, 3.4M+ SLOC, 52–54 leak, 49 confirmed — kiểm chứng trong `researchs/04`); bộ số "8 dự án / 3.6M LOC / 54 leak, 53 confirmed" thuộc bản arXiv đầu và đã bị bác bỏ. Điểm chung đáng nói: cả MemHint và hệ thống này đều cần LLM khám phá allocator, MemHint dùng LLM phân loại hàm, còn luận văn dùng LLM profiler với grep-verify (độ chính xác đo ở mục 4.9).

Với LAMeD [21] trên cJSON: Cooddy + annotation đạt P=0.933 / R=0.583. Khoảng cách với kết quả của hệ thống trên benchmark LAMeD chủ yếu do Cooddy có annotation function-level chi tiết hơn (AllocSource/FreeSink) so với allocator set đơn giản hơn của hệ thống. Đây chính là động lực cho tầng LLM allocator profiler, và là lý do cJSON được chọn làm scope validation của tầng đó.

---

## 4.8. Xác minh tái lập

### 4.8.1. Tier-1

Hai lần chạy no_llm (thư mục tách biệt, cùng cấu hình): TP29 FP7 FN3 TN38 y hệt. Gate `determinism-gate.sh` PASS.

### 4.8.2. Tier-2

Sweep full-corpus 1658 ca (mục 4.2.2, commit `5eec8b1`, model `deepseek-v4-flash`), B6a chạy 3 lần: F1 mean 0.863 ± 0.001, P mean 0.965 ± 0.002, R mean 0.780 ± 0.001, MCC mean 0.790 ± 0.002. B6b ± 0.003 và B7 ± 0.002 tương tự nhỏ. Trên mẫu stratified n=50 (thí nghiệm đầu, model khác), B6a 3 runs cho F1 mean 0.938 ± 0.015.

Variance nhỏ nhưng không phải không: ±0.001 trên full corpus đủ chặt để kết luận thứ hạng giữa các cụm cấu hình (B6/B6a so với B6b/B7) tái lập được, trong khi ±0.015 của mẫu n=50 nhắc rằng biến động thành phần mẫu lớn hơn biến động run LLM. LLM judge đủ ổn định cho practical use, nhưng không đủ cho bitwise reproducibility claim.

---

## 4.9. Độ chính xác LLM allocator profiling

Chạy `validate-allocator-profile.ts` trên toàn bộ 7 dự án LAMeD, model `deepseek-v4-flash` temp 0 (2026-08-19). Trên cJSON, scope mà paper LAMeD cite, profiler đạt:

- **Allocator: P 35% / R 92%, F1 0.51.**
- **Deallocator: P 67% / R 100%, F1 0.80.**

Recall cao, precision thấp. Phần "false positive" khi soi thủ công thực ra là allocator thật mà list hardcode bỏ sót, ví dụ `cJSON_Parse()`, `cJSON_Print()` trả owned memory. Nghĩa là LLM đầy đủ hơn list người viết tay; cái sai chủ yếu là hướng ngược lại (gắn nhãn allocator cho hàm không cấp phát). Ownership notes cũng chính xác: ví dụ `cJSONUtils_FindPointerFromObjectTo` trả chuỗi freed bằng `cJSON_free`.

Tuy nhiên, gộp trên cả 7 dự án thì số liệu thấp hơn hẳn: allocator P 24% / R 21% (F1 0.22), deallocator P 16% / R 19% (F1 0.17). cJSON là dự án nhỏ với naming convention đồng nhất (`cJSON_*`); các dự án còn lại dùng wrapper allocator đa hình hơn nhiều. Đây là giới hạn thật của tầng profiler trên dự án thực, và nó giải thích một phần vì sao recall trên LAMeD dừng ở 30% thay vì cao hơn: tầng phát hiện allocator, đầu vào của mọi tầng sau, chưa bám được các convention này.

---

## 4.10. Đánh giá trên corpus MemHint

MemHint [20] là baseline rò rỉ bộ nhớ C/C++ trực tiếp nhất trong related work: phân tích tĩnh neuro-symbolic kết hợp Z3 và bước xác nhận LLM, đo trên tập dự án thực. Danh sách leak từng ca của paper không được công bố, nên ground truth của họ không thể tái dùng trực tiếp. Chúng tôi vì thế tự dựng lại corpus: 19 ca rò rỉ từ 6 dự án thực (tmux, curl, openssl, redis, vim, freerdp), trùng 6 trong 7 dự án mục tiêu mà [20] liệt kê (thiếu FFmpeg). Mỗi ca gắn `github_url` trỏ đúng commit sửa lỗi, lưu trong `demo/memhint/memhint_bugs.json` để kiểm chứng độc lập. Corpus là positive-only như LAMeD: 26 site rò trên 19 ca, không có nhãn site sạch, vì thế recall và số FP là hai đại lượng chấm được (mục 4.1.5). Toàn bộ chạy trên WSL2 qua driver `scripts/memhint-eval-driver.sh`, commit `30e04cb1c`, lockfile `442de35d`, môi trường clang 14.0.0 và valgrind 3.18.1; artifacts nằm tại `results/memhint-no_llm-2026-08-28/` và `results/memhint-llm_assisted-2026-08-28/`.

### 4.10.1. Kết quả

Hai cấu hình được đo: `no_llm --enrich` (1 run) và `llm_assisted` (3 runs, model `deepseek-v4-flash` qua openai-compat, temp 0). Hệ chạy ở cấu hình đề xuất `llm_assisted` (nhóm fusion-B6 trong ablation, mục 4.2): planner và tool-selector là hai trục chỉ được bật trên Juliet, còn lệnh trên corpus này dùng `--strategy off` và `--no-tool-select`.

| Cấu hình | TP | FP | FN | Recall | Precision |
|---|--:|--:|--:|--:|--:|
| `no_llm --enrich` (1 run) | 12 | 0 | 14 | 0.462 | 1.000 |
| `llm_assisted` (mean 3 runs, std = 0) | 12 | 0 | 14 | 0.462 | 1.000 |

Hệ bắt 12 trên 26 site rò, không tạo FP nào; ba run `llm_assisted` cho confusion matrix giống hệt nhau {(12, 0, 14)}, tức P 1.000±0.000 / R 0.462±0.000 / F1 0.632±0.000. Sự đồng nhất này có nguyên nhân đo đếm được chứ không phải trùng hợp. Judge hybrid chỉ gọi LLM trên các bundle heuristic đánh dấu borderline, mà judge heuristic tự quyết khoảng 17,1 nghìn flagged verdict mỗi run; LLM judge chỉ can thiệp trên 2 site trong đúng 1/3 run (run 2, ca `freerdp_9fc23ad2`, judge paths {heuristic: 17154, llm: 2}), hai run còn lại đi thuần nhánh heuristic. Không một verdict nào bị lật. `llm_assisted` vì thế ≡ `no_llm` trên corpus này, cùng mẫu null với LAMeD (mục 4.5.1): LLM judging chỉ thêm giá trị khi bundle borderline thực sự tồn tại. Token vẫn tiêu, khoảng 44,3 triệu cho ba run llm (vào khoảng 26,5 triệu, ra khoảng 17,8 triệu), nhưng đổ vào allocator profiling và static fan-out chứ không tác động tới verdict.

### 4.10.2. Đối chiếu với số liệu MemHint tự báo

Trên tập dự án đầy đủ của mình, MemHint [20] tự báo 52-54 leak trên 7 dự án thực (3.4M+ SLOC), 49 ca confirmed/fixed, 4 CVE; cùng thiết lập đó, CodeQL tìm 19 và Infer 3. Corpus ở mục này chỉ là tập con 19 ca tự tái lập trên 6/7 dự án đó, chấm theo site với ground truth tự dựng, nên hai tập số không nằm trên cùng một mẫu số. So sánh vì thế chỉ mang tính định hướng: điểm dùng được là hệ đạt FP=0 với recall 46.2% trên lớp dự án thực tương tự, chứ không phải xác nhận hay bác bỏ con số của [20]. Paper này cũng chưa qua peer-review tại thời điểm viết.

### 4.10.3. Vì sao không chạy đủ 9 baseline trên corpus này

Protocol trên corpus MemHint chỉ gồm `no_llm` và `llm_assisted`, không lặp ablation 9 baseline như trên Juliet. Quyết định này có ba căn cứ, xếp theo sức mạnh tăng dần.

Thứ nhất, sức mạnh thống kê. Corpus positive-only 19 ca với 26 bug: TN=0 nên MCC không định nghĩa, và hiệu ứng có thể đo được giữa hai cấu hình là chênh 1-2 TP, tương đương 3.8-7.7 điểm recall trên mẫu số 26 site, nằm trong vùng nhiễu. Ablation 9 cấu hình chỉ có ý nghĩa trên corpus có nhóm đối chứng đủ lớn; Juliet 1658 ca với hơn 3.000 TN là nơi duy nhất trong luận văn thoả điều kiện đó.

Thứ hai, nhất quán protocol với LAMeD. Benchmark dự án thực trước đó (50 site, mục 4.5) cũng chỉ chạy hai công đoạn: `no_llm` mặc định, một biến thể `interproceduralFlow`, và `llm_assisted` ×3; 9 baseline không hề được chạy trên đó. MemHint theo đúng giao thức này.

Thứ ba, chi phí cộng precedent null. Dynamic stage trên repo thật chạy serialize với concurrency 1 (ca redis gồm 2235 files), mỗi cấu hình thêm khoảng 0.5-1 ngày build và sanitizer run, đủ 9 cấu hình tốn cỡ một tuần máy. LAMeD đã chỉ ra `llm_assisted` ≡ `no_llm` trên dự án thực, nên các biến thể LLM còn lại (B4-B7) gần như chắc chắn tái tạo null đó. Run MemHint này vừa xác nhận thêm bằng chứng: LLM judge chỉ can thiệp 2 site trên khoảng 17,1 nghìn quyết định verdict, không lật verdict nào.

### 4.10.4. Threats to validity

Áp lực bộ nhớ là giới hạn vận hành lớn nhất. Ca redis đẩy static analyzer vào dải OOM (khoảng 14GB RSS), nên driver phải thiết kế 8 lần retry với `--resume`; một lần VM reboot giữa run làm mất attempt đầu tiên, run chốt hoàn tất ở attempt 3/8 và artifacts được sha256-verify byte-identical qua reboot. Lần chạy đầu (2026-08-28) vì thế chỉ chấm được 11 ca, để lại anchor recall 42.3% (11/26) với 8 ca mất vì OOM; run chốt khôi phục đủ 19/19 và recall lên 46.2% (12/26). Vì `no_llm` bitwise deterministic, 11 ca đã chấm trước đó phải cho kết quả y hệt, nên +1 TP chắc chắn đến từ các ca recovered chứ không phải thay đổi code; thư mục kết quả vẫn giữ tên mốc 2026-08-28 của lần chạy đầu.

Phân bố FN cũng lệch: khối lớn nhất nằm ở vim, 3 ca với 2 FN mỗi ca trên tổng 14 FN. Cuối cùng, ground truth là tập tự tái lập 19 ca, không phủ toàn bộ tập leak của 7 dự án mà [20] nhắm tới; kết quả ở mục này đo hệ thống trên lớp dự án thực tương tự, không phải tái lập đánh giá của paper.

---

## 4.11. Tổng hợp chương

### Bảng tổng hợp toàn bộ kết quả

| Corpus | Cấu hình tốt nhất | F1 | P | R | Ghi chú |
|---|---|---|---|---|---|
| Juliet full 1658 ca | B6a | 0.863 | 0.965 | 0.780 | MCC 0.790, $6.63; sweep 9 baseline |
| Juliet n=50 stratified (thí nghiệm đầu, model cũ) | B6a | 0.938 | 0.973 | 0.906 | Phụ: ablation cấu phần, mẫu cân bằng family |
| LAMeD (50 site, positive-only) | no_llm = llm_assisted | — | 1.000 | 0.300 | TP15/FP0; Clang 0/43 site |
| MemHint (26 site, positive-only) | no_llm = llm_assisted | 0.632 | 1.000 | 0.462 | TP12/FP0; 19 ca tự tái lập, 6 dự án thực |
| Consensus K=3 (n=50 stratified) | không khuyến nghị | 0.793 | — | — | Thua single (F1 0.852, flip 2.0% vs 8.0%), p=0.077 |

Hai kết luận nổi lên từ bảng. Dynamic evidence đóng góp giảm FP mạnh nhất ở mọi quy mô: thêm dynamic giảm FP 470→74 trên full corpus (B4→B6), hiệu ứng này tái lập đúng mẫu 18→1 FP ở n=50. Ngược lại, consensus là kết quả âm tính có phương pháp luận: cơ chế chỉ thắng trên mẫu đơn-family lệch dễ, và thua trên mẫu đại diện, một phát hiện về hiệu ứng sampling mà nghiên cứu LLM-judge trước đó ít để ý.

Hai corpus dự án thực nói cùng một điều và nói theo cùng cách: trên LAMeD lẫn MemHint, ba cấu hình của hệ hội tụ về đúng kết quả no_llm, LLM judge được gọi nhưng không lật verdict nào, và recall dừng ở mức tầng allocator profiling cho phép (30.0% so với 46.2%). Null result lặp lại trên hai corpus độc lập là dữ kiện mạnh hơn một null result đơn lẻ: giá trị của LLM orchestration trước hết nằm ở tầng discovery và enrichment, còn judging chỉ hoạt động khi bundle borderline thật sự tồn tại, như trên Juliet full corpus.

### Điều kiện nào LLM orchestration có lợi?

Từ kết quả trên ba corpus, có thể rút ra ba điều kiện:

**Corpus khó, bundle borderline, nhưng còn phụ thuộc lớp allocator profiling.** Trên Juliet, heuristic finalize phần lớn bundle, nên judge LLM làm việc chủ yếu ở tầng đánh giá; cấu hình LLM tốt nhất (B6a 0.863) hơn static-only (B1 0.612) nhờ enrichment cộng judge đúng chỗ. Trên LAMeD, mọi cấu hình LLM hội tụ về đúng kết quả no_llm (LLM được gọi từ 47 đến 149 lần mỗi run, không lật verdict nào): khi tầng discovery đã bỏ sót site (recall profiling thấp trên dự án thực), judge không thể cứu những gì không bao giờ thành bundle. LLM orchestration có lợi trước hết khi candidate đúng đã vào pipeline.

**Cần cross-function reasoning, và tầng đó phải path-sensitive.** interproceduralFlow hiện tại Δ=0 trên cả Juliet lẫn LAMeD: tool đếm alloc/free không phân biệt nhánh, nên kết luận sai trên ca merge_patch. Bài học rộng hơn con số: orchestration chỉ hữu ích khi tool trong pipeline mạnh hơn heuristic nó bổ trợ; gọi một tool path-insensitive để xử lý leak path-sensitive chỉ tốn token.

**Chi phí phải được kiểm soát, và agentic phải trả giá bằng kết quả.** B6a là điểm ngọt: $6.63 cho F1 0.863. B7 agentic tốn $27.14 (khoảng 4 lần) cho F1 thấp hơn, B6b tương tự, trên cả hai quy mô mẫu và hai model. Cấu hình sản xuất là B6a; agentic tool-selection chỉ đáng cân nhắc khi exploration thật sự cần thiết, và bằng chứng hiện tại chưa chỉ ra corpus nào thuộc nhóm đó trong phạm vi luận văn.
