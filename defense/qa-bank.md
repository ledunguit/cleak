# Ngân hàng câu hỏi phòng vệ — qa-bank

> Mọi con số dưới đây trích từ `docs/RESULTS-FREEZE.md` (bảng freeze 10 nhóm) và
> các mục tương ứng của chương 4/5. Không số nào ngoài freeze. Ngày chốt: 2026-09-06.

---

## Q1. Vì sao consensus k=3 lại đảo chiều so với kết luận ban đầu? Đây có phải dấu hiệu hệ thống không ổn định?

**Trả lời:** Thí nghiệm đầu (n=30) kết luận consensus ổn định hơn 2 đến 4 lần, nhưng mẫu đó vô tình gồm 100% family `char` vì manifest Juliet xếp theo family mà lấy đầu danh sách không stratify. Khi lặp đúng protocol trên mẫu n=50 stratified đủ 10 family, kết quả đảo chiều: single-LLM lật verdict 2.0% (F1 0.852) trong khi consensus k=3 lật 8.0% (F1 0.793), hai đợt chạy độc lập cho cùng số. McNemar trên 205 site ghép cặp cho χ²=3.13, p=0.077, tức xu hướng nghiêng single nhưng chưa đạt ý nghĩa thống kê. Khi ba mẫu độc lập gần như luôn đồng ý, bỏ phiếu đang "ổn định hoá" thứ chưa từng bất ổn. Luận văn xử lý trung thực: báo cáo cả hai kết quả, không khuyến nghị consensus làm mặc định, và rút ra bài học phương pháp luận về hiệu ứng sampling trong đánh giá LLM judge.

*Nguồn: FREEZE nhóm 5; chương 4 §4.6, chương 5 §5.1 (RQ3).*

---

## Q2. std=0 trên LAMeD và MemHint có phải là lỗi đo, hay sweep bị lỗi nên chạy lại y hệt?

**Trả lời:** Không phải lỗi. Trên LAMeD, ba run llm_assisted cho confusion matrix trùng khớp từng ca (TP15/FP0/FN35, recall 30.0%) vì tầng dynamic là recipe ghim cứng (buildTarget → lsanRun) không có LLM trong vòng chạy, còn LLM judge được gọi 47 đến 149 lần mỗi run nhưng không lật verdict nào, nên kết quả chỉ phụ thuộc đầu vào tĩnh tất định. Trên MemHint, judge hybrid chỉ gọi LLM trên bundle borderline; không bundle nào borderline đủ, nên ba run cho cùng bộ {(12, 0, 14)}, F1 0.632±0.000. std=0 vì thế là hệ quả thiết kế "tất định trừ judge" chứ không phải replay máy móc: mỗi run đều đi qua toàn bộ pipeline thật. Đây chính là đóng góp C1: cô lập toàn bộ non-determinism vào judge.

*Nguồn: FREEZE nhóm 4 và nhóm 10; chương 4 §4.5, §4.10.1, chương 5 §5.2 (C1).*

---

## Q3. Vì sao không chạy đủ 9 baseline trên corpus MemHint (và LAMeD)?

**Trả lời:** Ba căn cứ, xếp theo sức mạnh tăng dần. Thứ nhất, sức mạnh thống kê: corpus positive-only 19 ca với 26 bug, TN=0 nên MCC không định nghĩa, và hiệu ứng đo được giữa hai cấu hình chỉ là chênh 1 đến 2 TP, tương đương 3.8 đến 7.7 điểm recall trên mẫu số 26 site, nằm trong vùng nhiễu; ablation 9 cấu hình chỉ có ý nghĩa trên corpus có nhóm đối chứng đủ lớn như Juliet 1658 ca. Thứ hai, nhất quán protocol với LAMeD, nơi cũng chỉ chạy no_llm, một biến thể interproceduralFlow, và llm_assisted ×3. Thứ ba, chi phí cộng precedent null: dynamic stage trên repo thật chạy serialize với concurrency 1, mỗi cấu hình thêm khoảng 0.5 đến 1 ngày build và sanitizer run, đủ 9 cấu hình tốn cỡ một tuần máy, trong khi LAMeD đã chỉ ra llm_assisted đồng nhất no_llm trên dự án thực nên các biến thể LLM còn lại có xác suất null cao.

*Nguồn: chương 4 §4.10.3, §4.5; FREEZE nhóm 4, nhóm 10.*

---

## Q4. Ground truth MemHint là tập tự tái lập, vì sao tin được?

**Trả lời:** Danh sách leak của paper MemHint gốc không công bố nên không thể tái dùng trực tiếp; chúng tôi dựng lại 19 ca trên 6 trong 7 dự án của tập mục tiêu, với mỗi ca ghi `github_url` trỏ về commit/báo lỗi thật để kiểm chứng độc lập được từng ca. Corpus được khóa bằng lockfile với content-hash `442de35d6410bdd03d30b665b5f0f912` và gate kiểm tra hash tại thời điểm chạy, đúng cơ chế validation đã dùng cho Juliet và LAMeD. Kết quả được đối chiếu với số tự báo của MemHint theo cách minh bạch: paper báo 52-54 leak trên 7 dự án (3.4M+ SLOC), corpus của chúng tôi chỉ là tập con 19 ca chấm theo site với ground truth tự dựng, nên hai tập số không so trực tiếp được và luận văn nói rõ điều đó. Việc dựng lạ đúng quy trình validation 5-gate thay vì tin nguyên văn paper là điểm mạnh, không phải điểm yếu.

*Nguồn: FREEZE nhóm 10 (corpus hash); chương 4 §4.10.1, §4.10.2, chương 2 §2.9.*

---

## Q5. Con số 0.863 so với 0.612 được đo thế nào để công bằng?

**Trả lời:** Hai cấu hình chạy trong cùng một sweep 9 baseline, cùng commit `5eec8b1`, trên đủ 1658 ca Juliet CWE-401, cùng scorer. B6a (planner + recipe động tất định + LLM judge) đạt precision 0.965, recall 0.780, F1 0.863±0.001, MCC 0.790; baseline tĩnh thuần B1 cùng sweep đạt F1 0.612. Một run no_llm postfix4 độc lập (commit `c07bee5`) cho đúng bộ precision 68.0%, recall 55.6%, F1 0.612, xác nhận chéo mốc baseline. Chênh lệch 0.251 F1 vì thế đo được trên cùng corpus, cùng scorer, cùng thế hệ code; luận văn cấm đất so 0.863 với các số thuộc thế hệ commit cũ hơn như 0.776 (run 2026-08-11, chỉ dùng cho dữ liệu chi phí và đường judge).

*Nguồn: FREEZE nhóm 1, nhóm 2, nhóm 3 và reading rules; chương 4 §4.2.2, chương 5 §5.1 (RQ1).*

---

## Q6. Vì sao stratified n=50 cho 0.938 trong khi full-corpus chỉ 0.863? Số nào là đúng?

**Trả lời:** Cả hai đúng, vì chúng trả lời hai câu hỏi khác nhau: 0.938±0.015 là ablation component trên mẫu cân bằng family (48/1/5/156), còn 0.863±0.001 là hiệu năng toàn corpus. Family variance đo trên chính các run B6a của sweep toàn corpus giải thích khoảng cách: F1 0.991 trên family malloc nhưng chỉ 0.584 trên strdup (trung bình 3 run: 0.975 và 0.576). Mẫu stratified cân bằng family làm giảmweight các family khó chiếm tỷ lệ lớn trong corpus thật (C++ new/delete, malloc), nên điểm cao hơn; full-corpus phản ánh hiệu năng thực khi triển khai. Luận văn báo cáo cả hai và dùng cặp số này làm ví dụ cho bài học sampling, cùng bài học đã lật chiều kết luận consensus ở RQ3.

*Nguồn: FREEZE nhóm 1, nhóm 7; chương 4 §4.2.5, chương 5 §5.3.*

---

## Q7. Ca redis đẩy static analyzer vào dải OOM 14GB, điều đó có làm kết quả MemHint không đáng tin?

**Trả lời:** Áp lực bộ nhớ là giới hạn vận hành lớn nhất và được ghi nhận thẳng vào threats to validity. Driver thiết kế 8 lần retry với `--resume`: một lần VM reboot giữa run làm mất attempt đầu, run chốt hoàn tất ở attempt 3/8, và artifacts được sha256-verify byte-identical qua reboot, nên không có ca nào bị bỏ hay đo hai lần lệch nhau. Resume hoạt động qua per-case disk cache, ca đã chấm được fast-forward, ca lỗi được chạy lại. Khối FN lớn nhất (vim, 3 ca với 2 FN mỗi ca) là giới hạn năng lực phân tích thật, không phải lỗi vận hành, và cũng được ghi nhận riêng. Kết quả 12/26 site vì thế đo được trên đủ 19/19 ca đã chấm.

*Nguồn: FREEZE nhóm 10; chương 4 §4.10.4; notepad learnings (driver retry/resume).*

---

## Q8. Positive-only scoring nghĩa là gì, và precision 100% trên corpus thực có phải là "làm màu"?

**Trả lời:** LAMeD và MemHint là corpus positive-only: chỉ chứa site thật sự rò, không có negative sample, nên TN=0 theo cách dựng corpus, và precision cùng MCC không định nghĩa trên hai corpus này. Quy ước so sánh được là recall và số FP; FP=0 trên 50 site LAMeD là kết quả mạnh, nhưng phải đọc kèm recall 30.0% (bỏ sót 35/50 site). Trên Juliet, corpus có đủ bốn ô confusion, precision của B6a là 0.965, và hai precision gate (dynamic cleared, strong signal required) là cơ chế thật ngăn FP chứ không phải rule thủ lợi. Luận văn giữ quy ước này nhất quán trên mọi bảng.

*Nguồn: FREEZE reading rules, nhóm 4, nhóm 10; chương 4 §4.1.2, §4.5, §4.10.*

---

## Q9. Nhánh agentic B7 đắt gấp 4 lần B6a mà kém hơn, vậy LLM orchestration đáng giá ở đâu?

**Trả lời:** Trong cùng sweep, B7 agentic đầy đủ tốn 27.14 USD, khoảng 4 lần B6a (6.63 USD), đổi lại F1 0.856 so với 0.863. Giá trị của LLM không nằm ở việc thăm dò công cụ tự do: trên corpus synthetic như Juliet, tool selection agentic phần lớn gọi lại những công cụ mà bằng chứng tĩnh đã đủ để kết luận. Điểm ngọt là cách bố trí B6a: planner LLM gate luồng chạy, recipe tất định chạy dynamic, LLM judge chỉ chốt verdict cuối cùng, và chính cấu hình đó đạt full-corpus mạnh nhất. Xếp hạng sweep cho thấy thông điệp rõ: bốn cấu hình đầu đều có LLM, nhưng B5 và B2 tụt xuống 0.392, dưới cả baseline tĩnh; thêm LLM không tự động tốt hơn, giá trị đến từ vị trí bố trí.

*Nguồn: FREEZE nhóm 1; chương 4 §4.2, chương 5 §5.3 (Chi phí của agentic).*

---

## Q10. Vì sao không ép toàn bộ hệ thống tất định bit-for-bit thay vì giao thức hai tầng?

**Trả lời:** Vì judge LLM mang sampling phía provider: ngay cả temperature=0, provider không bảo đảm bit-for-bit do batching phía hệ thống, nên ép mọi thứ về một chuẩn chung là giả vờ như một giới hạn vật lý không tồn tại. Giao thức hai tầng là câu trả lời thiết kế: Tier 1 (no_llm) tất định bit-for-bit, hai lần chạy tách thư mục cho bảng nhầm lẫn trùng từng ca (TP29/FP7/FN3/TN38), được gate `determinism-gate.sh` chứng nhận và gate này biết từ chối hai kiểu đậu giả đã gặp thật (so thư mục với chính nó vì trùng dấu thời gian, và run degenerate all-error); Tier 2 (llm_assisted) được báo cáo dạng phân phối mean±std cộng tỉ lệ lật verdict từng ca. Consensus, như RQ3 cho thấy, không khắc phục được, nó chỉ trộn thêm sampling vào sampling.

*Nguồn: chương 4 §4.8, chương 5 §5.3 (Bản chất non-deterministic), §5.2 (C2).*

---

## Q11. Trên MemHint, LLM có làm gì đáng kể không khi llm_assisted đồng nhất no_llm?

**Trả lời:** Đường judge thì không, và luận văn nói rõ: judge hybrid quyết định ~17.1k flagged verdicts mỗi run theo heuristic; LLM judge chỉ fired trên 2 site trong một trong ba run (run 2, judge paths {heuristic: 17154, llm: 2}; run 1 và 3 thuần heuristic), không bundle borderline nào nên llm_assisted đồng nhất no_llm theo thiết kế. Nhưng LLM vẫn làm việc thật ở tầng khác: allocator profiling và static fan-out tiêu tốn khoảng 44.3M tokens qua 3 run (in khoảng 26.5M, out khoảng 17.8M) mà không đổi confusion matrix. Đây là phát hiện có nội dung: LLM judging chỉ tạo giá trị khi bundle borderline tồn tại, và trên corpus mà heuristic đã tự tin thì chi phí LLM judge là thừa. Bài học này ghép với kết quả consensus thành một câu chuyện nhất quán về việc bố trí LLM đúng chỗ.

*Nguồn: FREEZE nhóm 10; notepad learnings (judge-path truth); chương 4 §4.10.1, chương 5 §5.2 (C4).*

---

## Q12. Kết quả chỉ đo trên một mô hình (deepseek-v4-flash), làm sao biết không phụ thuộc model?

**Trả lời:** Các sweep formal dùng deepseek-v4-flash và trục model chưa bao giờ được thiết kế thành ablation, luận văn thừa nhận đây là hạn chế. Tuy nhiên có bằng chứng phụ trên hai sweep B6a đầy đủ 1658 ca với model khác: B6a-mimo cho F1 0.737 (P 0.880 / R 0.633, chi phí 2.11 USD) và B6a-zai cho F1 0.774 từ run 1 hoàn chỉnh (run 2 partial 25/1658 bị loại), tức xu hướng "B6a vượt baseline tĩnh và giữ hạng cao" giữ đúng hướng trên model khác dù mức tuyệt đối thay đổi. So sánh model đầy đủ, cùng corpus cùng scorer, nằm trong hướng phát triển tương lai cùng với ablation theo trục model. Luận văn chọn trung thực: ghi rõ phạm vi của kết quả thay vì khái quát quá mức dữ liệu cho phép.

*Nguồn: FREEZE nhóm 8, nhóm 9; chương 5 §5.4 (Một mô hình chính), §5.5 (Ablation theo trục model).*

---

## Ghi chú nguồn chạy judge (tham khảo nhanh)

| Run | Judge paths |
|---|---|
| MemHint run 1 | {heuristic: 17157} |
| MemHint run 2 | {heuristic: 17154, llm: 2} |
| MemHint run 3 | {heuristic: 17106} |
