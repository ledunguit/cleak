# Chương 5: Kết luận và hướng phát triển trong tương lai

Câu hỏi khởi nguồn của luận văn nghe rất đơn giản: liệu một LLM điều phối công cụ phân tích tĩnh và động có phát hiện memory leak tốt hơn việc dùng từng công cụ một? Trả lời câu đó đòi hỏi bốn chương: bối cảnh và các hướng tiếp cận hiện có (Chương 1), kiến trúc HYBRID (Chương 2), hiện thực hoá hệ thống (Chương 3), đánh giá thực nghiệm trên hai loại corpus (Chương 4). Chương cuối này chốt lại câu trả lời cho bốn câu hỏi nghiên cứu trên số liệu đã chốt, khái quát bốn đóng góp, rồi bàn về những gì hệ thống chưa làm được cùng hướng đi tiếp.

---

## 5.1. Trả lời câu hỏi nghiên cứu

### RQ1: LLM orchestration có cải thiện hiệu suất phát hiện leak không?

Có, trên toàn bộ corpus, với điều kiện LLM đứng đúng vị trí. So sánh quyết nằm trong cùng một sweep 9 baseline, cùng commit `5eec8b1`, trên đủ 1658 ca Juliet CWE-401 (mục 4.2): B6a, cấu hình đề xuất gồm planner, recipe động tất định và LLM judge, đạt F1 0.863 với precision 0.965, recall 0.780, MCC 0.790. Baseline tĩnh thuần B1 trong cùng sweep chỉ đạt F1 0.612. Một run no_llm postfix4 độc lập (commit `c07bee5`) cho đúng bộ số precision 68.0%, recall 55.6%, F1 0.612, xác nhận chéo cho mốc baseline này. Chênh lệch 0.251 F1 vì thế đo được trên cùng corpus, cùng scorer, cùng thế hệ code.

Xếp hạng đầy đủ của sweep: B6a 0.863, B6 0.862, B6b 0.858, B7 0.856, B4 0.801, B3 0.683, B1 0.612, rồi B5 và B2 cùng 0.392. Bốn cấu hình đứng đầu đều có LLM, nhưng hai cấu hình cuối cùng lại tụt dưới cả baseline tĩnh. Sự phân tán đó chính là thông điệp: thêm LLM vào không tự động làm hệ tốt hơn. Giá trị đến từ cách bố trí, planner gate luồng chạy, recipe ghim cứng phần chạy động, judge chỉ chốt verdict cuối.

Chi phí đi kèm cũng phân hoá theo thiết kế. B7, nhánh agentic đầy đủ, tốn 27.14 USD, khoảng 4 lần B6a (6.63 USD), đổi lại F1 thấp hơn (0.856 so với 0.863). Trên corpus synthetic như Juliet, việc thăm dò công cụ theo kiểu agentic phần lớn gọi lại những công cụ mà bằng chứng tĩnh đã đủ để kết luận.

Câu trả lời RQ1 vì thế là có, nhưng có điều kiện: nhánh judge LLM trong cấu hình đề xuất nâng F1 từ 0.612 lên 0.863 trên toàn corpus; các cách dùng LLM khác, tiêu biểu là tool selection agentic, có thể không chỉ đắt hơn mà còn kém hơn.

### RQ2: Kết quả có tái lập được không?

Mỗi chế độ chạy được báo cáo theo đúng bản chất tất định của nó, tạo thành giao thức hai tầng (mục 4.8). Tầng 1 áp dụng cho no_llm, tầng 2 cho llm_assisted; hai tầng không ép về một chuẩn chung.

Tier 1 phải tất định tuyệt đối, và thực sự như vậy. Hai lần chạy no_llm tách thư mục, cùng cấu hình, cho bảng nhầm lẫn trùng từng ca: TP29, FP7, FN3, TN38. Gate `determinism-gate.sh` chứng nhận điều này và đồng thời từ chối hai kiểu đậu giả đã gặp thật trong quá trình phát triển: so thư mục với chính nó vì trùng dấu thời gian, và một run degenerate (mất kết nối analyzer nên mọi ca lỗi) dễ bị nhầm là "tất định". Trên toàn corpus, run no_llm postfix4 chốt mốc tầng 1: precision 68.0%, recall 55.6%, F1 0.612, MCC 0.375.

Tier 2 không thể đồng nhất bit-for-bit vì judge LLM mang sampling phía provider, nên số liệu được báo cáo dạng phân phối. Sweep chính chạy 3 lần cho mỗi cấu hình LLM: B6a cho F1 0.863±0.001. Trên LAMeD, ba run llm_assisted cho std=0 (mục 4.5). Sweep stratified n=50 ghi B6a 0.938±0.015 (mục 4.2). Kèm mean±std, tỉ lệ lật verdict từng ca được đo riêng qua `verdict-stability.ts`, vì tổng hợp có thể trùng nhau do may trong khi verdict từng ca vẫn dao động.

Một run llm_assisted thuộc thế hệ commit cũ hơn (`9db30f0`, sinh ngày 2026-08-11, trước chuỗi fix reference-out-param, virtual-dispatch và RAII của 2026-08-12) được giữ lại chỉ cho dữ liệu chi phí và đường judge: 66.4% verdict bị flag do heuristic chốt, 33.6% do LLM chốt. Run này không tham gia bất kỳ so sánh hiệu suất nào vì lệch thế hệ code so với sweep chính.

### RQ3: Consensus voting có giảm dao động verdict không?

Thí nghiệm đầu nói có. Trên mẫu n=30, nhánh single-LLM lật verdict 13.3 đến 26.7% giữa các lần chạy, nhánh consensus K=3 lặp lại y hệt 6.7% qua hai đợt; McNemar cho p=0.45, xu hướng nghiêng consensus nhưng chưa đạt ý nghĩa thống kê. Khi đó, kết luận "consensus ổn định hơn 2 đến 4 lần" có vẻ vững.

Mẫu n=30 đó lại vô tình gồm 100% family `char`, do manifest Juliet xếp theo family mà lấy đầu danh sách không stratify. Lặp đúng protocol trên mẫu n=50 stratified đủ 10 family (commit `f0d371c`, mục 4.6) đảo chiều hoàn toàn kết quả:

| Nhánh judge | Tỉ lệ lật verdict | F1 |
|---|---|---|
| Single-LLM (k=1) | 2.0% | 0.852 |
| Consensus (k=3) | 8.0% | 0.793 |

Hai đợt chạy độc lập cho cùng số trên. McNemar trên 205 site ghép cặp: 7/8 cặp bất đồng nghiêng về single, χ²=3.13, p=0.077.

Điều thú vị là bảng này không nói consensus tệ, mà nói kết quả đầu tiên là sản phẩm của cách lấy mẫu. Khi ba mẫu độc lập gần như luôn đồng ý, bỏ phiếu đang "ổn định hoá" thứ chưa từng bất ổn. Trên mẫu đại diện đủ family, chính single-LLM ổn định hơn và chính xác hơn; mức p=0.077 vẫn dưới ngưỡng ý nghĩa nên luận văn dừng ở "xu hướng nghiêng single", không khẳng định mạnh hơn dữ liệu cho phép.

Kết luận RQ3: consensus không được khuyến nghị bật mặc định. Cơ chế vẫn là code thật, vẫn opt-in qua `consensus.n > 1`, và luận văn báo cáo cả hai kết quả thay vì chỉ giữ số thuận lợi. Với nghiên cứu LLM-judge nói chung, đây là một ví dụ cụ thể cho việc hiệu ứng sampling có thể lật chiều một ablation.

### RQ4: Hệ thống hoạt động ra sao trên dự án thực?

Trên LAMeD, 41 ca từ 7 dự án C thật với 50 site rò sau khi chỉnh lại denominator (mục 4.5), hệ thống bắt TP15, FP0, FN35, recall 30.0%. Ba lần chạy llm_assisted cho std=0 và trùng khớp từng ca với no_llm. LLM judge thực tế được gọi từ 47 đến 149 lần mỗi run nhưng không lật verdict nào; thêm interproceduralFlow vào đường evidence tĩnh cũng cho kết quả byte-identical (Δ=0). Clang Static Analyzer trên corpus này bắt 0 trên 43 site; hai mẫu số 43 và 50 khác nhau do scorer chấm mỗi hệ trên granularity finding của chính nó, không phải lỗi đo (chi tiết ở mục 4.7).

Ca dự án thực đầu tiên hệ bắt được có giá trị minh hoạ riêng: leak tham số `target` của `cJSON_merge_patch`, rò trên đúng một đường lỗi, được phát hiện nhờ scoring parameter-ownership kết hợp guard-subset reconciliation (kể chi tiết ở mục 4.5.2). Ba mươi lăm site còn sót thuộc các lớp khó: hai ca cần mô hình hoá deallocator semantics, hai ca path-sensitive, phần còn lại là ownership interprocedural phức tạp. Chính LAMeD cũng chỉ báo 5-10 trên 43 site cho các công cụ có annotation.

Corpus thực thứ hai là MemHint: 19 ca trên 6 dự án lớn (vim, redis, openssl...), ground truth tự tái lập vào file JSON vì danh sách bug của paper gốc không công bố. Giao thức gồm một run no_llm kèm enrich và ba run llm_assisted, điều phối bởi `scripts/memhint-eval-driver.sh` với resume tự động qua từng lần lỗi OOM. Tại thời điểm viết chương này, hai nhóm run MemHint chưa hoàn tất; số liệu [PENDING, bổ sung vào mục tương ứng của chương 4 khi run xong] và không con số nào được suy đoán cho corpus đó.

Cả hai corpus thực dùng quy ước positive-only: recall và số FP là hai đại lượng so sánh được, còn precision và MCC không định nghĩa vì TN=0 theo cách dựng corpus (mục 4.1.2). FP=0 trên 50 site vì thế là kết quả mạnh, nhưng phải đọc kèm recall 30%.

---

## 5.2. Đóng góp của luận văn

Bốn đóng góp dưới đây xếp theo thứ tự trọng tâm sau khi mọi kết quả đã chốt: pipeline tất định-trừ-judge là novelty trung tâm, còn consensus được trình bày như một kỹ thuật đã điều tra kỹ với kết quả âm trung thực.

**C1: Pipeline hybrid tất định-trừ-judge.** Tầng dynamic được tất định hoá triệt để: recipe build cộng sanitizer run ghim cứng (buildTarget → lsanRun), không LLM trong vòng chạy; mọi finding được capture tất định vào store; planner LLM chỉ gate luồng, không tự ghi evidence. Judge trở thành nơi duy nhất còn sampling, và cấu hình đạt kết quả full-corpus mạnh nhất chính là cấu hình đó: B6a với F1 0.863, MCC 0.790. Trên corpus thực, pipeline chạy ba lần cho std=0.

**C2: Giao thức tái lập hai tầng.** Tier 1 (no_llm) tất định bit-for-bit, được gate chứng nhận và biết từ chối hai kiểu đậu giả. Tier 2 (llm_assisted) báo cáo phân phối: mean±std qua nhiều lần chạy, cộng tỉ lệ lật verdict từng ca. Mỗi chế độ được đo theo bản chất của nó; một tổng số trùng khớp không còn có thể che giấu dao động cấp ca.

**C3: Làm giàu bằng chứng cho judge.** Mỗi bundle mang ownership của biến, cặp alloc→free, feasible-leak-path và correlationMethod phân biệt tương quan chặt (khớp file, dòng, hàm) với tương quan yếu (chỉ file). Mọi verdict truy vết được về bằng chứng trong snapshot.json và hiển thị trong báo cáo cùng TUI. Allocator annotation theo dự án, do LLM profiler đọc source rồi grep-verify, mở rộng discovery sang factory allocator kiểu `cJSON_Duplicate` mà danh sách hardcode bỏ sót.

**C4: Consensus judge với kết quả âm trung thực.** Cơ chế k mẫu độc lập, precision-override veto và escalation theo bất đồng static-dynamic là code thật, đã tối ưu chi phí bằng batch judging. Trên mẫu đại diện n=50, nó thua cả về ổn định lẫn F1 so với single-LLM; luận văn báo cáo cả hai kết quả, không khuyến nghị mặc định, và rút ra bài học phương pháp luận về sampling. Kết quả âm được kể đủ là một đóng góp, không phải điểm yếu cần giấu.

---

## 5.3. Bàn luận

### Hai cách lấy mẫu, hai con số

Sweep stratified n=50 cho B6a 0.938±0.015 trong khi sweep toàn corpus cho 0.863±0.001 (mục 4.2). Hai con số không mâu thuẫn; chúng trả lời hai câu hỏi khác nhau, một về ablation component trên mẫu cân bằng family, một về hiệu năng toàn corpus. Family variance đo trên chính các run B6a của sweep toàn corpus giải thích khoảng cách: F1 0.991 trên family malloc nhưng chỉ 0.584 trên strdup. Bài học lấy mẫu này chảy thẳng vào kết quả consensus ở RQ3, nơi cùng một cơ chế đổi chiều chỉ vì mẫu đổi từ ngẫu nhiên thành stratified.

### Chi phí của agentic

Sweep 9 baseline tốn 75.78 USD tổng cộng, trong đó B7 agentic chiếm 27.14 USD, khoảng 4 lần B6a, để đạt F1 thấp hơn. Điểm ngọt nằm ở B6a: planner gate luồng, recipe tất định chạy dynamic, LLM chỉ chốt verdict ở cuối. Agentic tool selection trên corpus dễ phần lớn gọi lại những công cụ mà bằng chứng tĩnh đã đủ để kết luận.

### Bản chất non-deterministic của LLM judge

Ngay cả temperature=0, provider không bảo đảm bit-for-bit do batching phía hệ thống. Giao thức hai tầng là câu trả lời thiết kế cho giới hạn đó: tầng nào cần tất định thì tách LLM ra, tầng nào có LLM thì báo phân phối. Consensus, như RQ3 cho thấy, không phải cách khắc phục; nó chỉ trộn thêm sampling vào sampling.

### Path-sensitive: heuristic CFG chưa đủ chính xác

Bật static enrichment dựa trên CFG heuristic trên fixture Juliet trước remediation làm FP vọt từ 7 lên 44 (số đo ghi trong tài liệu đóng góp của hệ thống). Prototype Z3 từng cắt ngược về 8 nhờ phát hiện đường rò bất khả thi, nhưng bị loại khỏi kiến trúc: runtime WASM chặn heap 2 GiB, abort không bắt được, analyzer treo. In-process SMT vì thế được kết luận bất khả thi trong phạm vi này; hướng thay thế là kết hợp static với dynamic cộng judge, còn enrichment giữ opt-in.

---

## 5.4. Hạn chế của nghiên cứu

**Corpus synthetic là chính.** Juliet có pattern công thức: hàm `bad()` luôn leak, hàm `good()` không bao giờ. Kết quả toàn corpus bị kéo xuống bởi các family khó (C++ new/delete, malloc) mà mẫu cân bằng family che đi; không có corpus nào trong nghiên cứu này đủ lớn để khẳng định thứ bậc tuyệt đối giữa các hệ.

**Một mô hình chính.** Các sweep formal dùng deepseek-v4-flash. Hai sweep phụ B6a-mimo (F1 0.737) và B6a-zai (F1 0.774 từ run 1 hoàn chỉnh) cho thấy xu hướng giữ đúng hướng trên mô hình khác, nhưng trục model chưa bao giờ được thiết kế thành ablation; so sánh đầy đủ giữa các mô hình nằm ngoài phạm vi.

**Baseline mỏng.** Chỉ LAMeD (EASE 2025) là peer-reviewed đầy đủ cho leak C/C++; MemHint là preprint. Baseline so sánh trực tiếp cùng corpus, cùng scorer chỉ có Clang Static Analyzer.

**Corpus thực positive-only và nhỏ.** LAMeD có 41 ca, MemHint 19 ca; TN=0 nên precision và MCC không định nghĩa trên hai corpus này. FP=0 đọc phải kèm recall.

**Recall dự án thực 30%.** 35 trên 50 site bị bỏ sót, phần lớn thuộc các lớp cần deallocator semantics, path-sensitive feasibility hoặc ownership interprocedural.

**Parse OOM trên repo khổng lồ.** Tree-sitter với cache giới hạn byte vẫn có thể cạn bộ nhớ trên repo rất lớn. Đây là giới hạn scale được ghi nhận, không sửa trong phạm vi luận văn.

**MemHint chưa hoàn tất khi viết chương này.** Nếu các run không kết thúc được, corpus đó sẽ được báo cáo như threats-to-validity thay vì kết quả.

---

## 5.5. Hướng phát triển trong tương lai

**Che phủ các family Juliet còn lại.** Các flow-variant 44, 45, 63-68 (C++ reference shapes), 81-82 (virtual dispatch FN) và 83-84 (RAII FN) chưa được xử lý. Đây là nguồn FN còn lại trên corpus synthetic và là đích mở rộng tự nhiên của heuristic judge.

**Dataflow interprocedural nhận diện alias.** interproceduralFlow hiện theo dõi biến theo tên. Pointer analysis, chẳng hạn qua LLVM, sẽ cho theo dõi con trỏ qua biên hàm chính xác hơn; hiện tại một biến được gán lại qua tham số dễ làm mất dấu.

**Mô hình hoá deallocator semantics.** `cJSON_Delete` bỏ qua buffer có cờ const, một ngữ nghĩa mà code thuần không mã hoá nổi. Hướng đã chuẩn bị sẵn: LLM đọc implementation của deallocator, suy luận rule, grep-verify rồi cache theo dự án.

**Path feasibility ngoài tiến trình.** SMT in-process đã bị loại vì trần heap WASM. Chạy Z3 thành tiến trình riêng, hoặc giới hạn query trên đường lỗi ngắn, là hướng còn mở.

**Ablation theo trục model.** Hiện chỉ có bằng chứng phụ từ hai sweep B6a-mimo và B6a-zai. Một sweep thiết kế đầy đủ nhiều mô hình, cùng corpus cùng scorer, mới trả lời được câu hỏi độ nhạy của kết quả với model.

**Mở rộng scale parsing.** Cắt incremental hoặc streaming cho tree-sitter trên repo khổng lồ để loại rủi ro OOM, kết hợp song song hoá worker parse.

**Corpus khó hơn và negative samples.** Mở rộng LAMeD, dựng corpus từ CVE database (DiverseVul [10], CVEfixes) và bổ sung negative samples để đo precision đầy đủ.

**MCP ecosystem.** Kiến trúc MCP cho phép tool mới từ cộng đồng plug vào orchestrator không cần sửa. Tool phân tích Rust ownership hoặc CVE lookup là hai ví dụ gần nhất.

Điểm neo xuyên suốt bốn chương là một lựa chọn thiết kế: những gì có thể tất định thì tất định, chỉ phần không thể (judge LLM) mới được chấp nhận dao động và được đo đàng hoàng. Số liệu toàn corpus khẳng định lựa chọn đó: 0.863 so với 0.612 trong cùng sweep, std=0 trên dự án thực, và một negative result về consensus được kể trung thực. Luận văn để lại cho người sau một giao thức tái lập hai tầng, một bảng đóng băng kết quả truy vết được, và một câu hỏi mở đáng giá về hiệu ứng sampling trong đánh giá LLM judge.
