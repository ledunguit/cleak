# Chương 1: Các nghiên cứu và công nghệ liên quan

Trước khi trình bày thiết kế và kết quả của hệ thống, cần đặt nghiên cứu này vào bối cảnh học thuật rộng hơn. Chương này khảo sát các hướng tiếp cận đã có — từ công cụ phân tích tĩnh và động truyền thống, cho đến các hệ thống dùng mô hình ngôn ngữ lớn (LLM) để phát hiện lỗi — nhằm chỉ ra khoảng trống mà luận văn nhắm lấp đầy.

---

## 1.1. Memory leak trong C/C++

### 1.1.1. Định nghĩa và phân loại

Memory leak xảy ra khi chương trình cấp phát bộ nhớ nhưng không giải phóng sau khi sử dụng xong, khiến vùng nhớ đó không thể tái sử dụng [37]. Trong C/C++, nơi quản lý bộ nhớ là trách nhiệm của lập trình viên, loại lỗi này đặc biệt phổ biến. MITRE phân loại memory leak thuộc CWE-401 ("Missing Release of Memory after Effective Lifetime"), một biến thể con của CWE-772 ("Missing Release of Resource after Effective Lifetime") [37].

Cần phân biệt memory leak với các lỗi liên quan: use-after-free (truy cập bộ nhớ đã giải phóng, CWE-416), double-free (giải phóng hai lần, CWE-415), và buffer overflow (tràn vùng đệm, CWE-120). Dù đều thuộc nhóm memory safety, cơ chế phát hiện và sửa chữa hoàn toàn khác nhau.

### 1.1.2. Patterns phổ biến

Qua phân tích benchmark Juliet [37] và các CVE thực tế, có thể tóm tắt thành sáu patterns chính:

**Missing free đơn giản.** Bộ nhớ được cấp phát nhưng không có lệnh giải phóng nào trong hàm. Đây là pattern dễ phát hiện nhất, thường do lập trình viên quên gọi `free()`.

**Path-sensitive leak.** Bộ nhớ được giải phóng trên một số đường thực thi nhưng không trên đường khác. Ví dụ kinh điển từ trang chính thức CWE-401 [37]:

```c
char* getBlock(int fd) {
    char* buf = (char*) malloc(BLOCK_SIZE);
    if (!buf) { return NULL; }
    if (read(fd, buf, BLOCK_SIZE) != BLOCK_SIZE) {
        return NULL;  // buf bị rò rỉ ở đây
    }
    return buf;
}
```

Pattern này đòi hỏi phân tích nhạy cảm đường đi (path-sensitive analysis) — một thách thức lớn đối với cả công cụ tĩnh lẫn động.

**Interprocedural leak.** Bộ nhớ được cấp phát ở hàm A, truyền cho hàm B, nhưng không hàm nào giải phóng. Việc theo dõi dòng dữ liệu qua biên hàm phức tạp hơn nhiều so với phân tích trong một hàm.

**Factory-allocator leak.** Các hàm factory như `cJSON_CreateObject()`, `TIFFOpen()` trả về con trỏ đã cấp phát mà không có từ khóa `malloc`/`alloc` trong tên. Công cụ tĩnh dựa trên pattern matching sẽ bỏ sót nếu không biết tên các hàm này.

**Parameter-ownership leak.** Hàm nhận con trỏ tham số, giải phóng trên một số đường nhưng không trên đường khác. Ví dụ: hàm `cJSON_merge_patch` giải phóng `target` trên đường thành công nhưng quên trên đường lỗi — leak thực tế đầu tiên mà hệ thống trong luận văn này bắt được.

**Overwritten pointer.** Con trỏ được gán lại mà không giải phóng vùng nhớ cũ, làm mất tham chiếu đến vùng nhớ đã cấp phát.

### 1.1.3. Tác động thực tế

Memory leak không chỉ là vấn đề lý thuyết. Các CVE dưới đây cho thấy hậu quả thực tế:

- **CVE-2024-2398** (curl): Rò rỉ bộ nhớ trong xử lý HTTP/2 push headers, ảnh hưởng phiên bản 7.44.0 đến 8.6.0. Kẻ tấn công có thể khai thác để gây từ chối dịch vụ.
- **CVE-2016-0799** (OpenSSL): Leak trong `BN_hex2bn()` và `BN_dec2bn()`, cho phép gây DoS qua tải tài nguyên cạn kiệt.
- **CVE-2023-0461** (Linux kernel): Leak trong garbage collector của `af_unix`, ảnh hưởng hệ thống socket.
- **CVE-2023-32233** (Linux kernel): Use-after-free kết hợp leak trong Netfilter `nf_tables`, dẫn đến leo thang đặc quyền.

Điểm chung: leak trong các dự án lớn thường không phải lỗi logic đơn giản, mà là hệ quả của tương tác phức tạp giữa nhiều hàm, nhiều nhánh điều kiện, và quy tắc sở hữu không rõ ràng.

### 1.1.4. Độ phức tạp của bài toán

Phát hiện memory leak chính xác đòi hỏi giải quyết ba bài toán con: (1) xác định vùng nhớ nào được cấp phát — khó khi allocator là hàm factory chứ không phải `malloc`; (2) xác định vùng nhớ nào được giải phóng — khó khi free nằm ở hàm khác hoặc trên một nhánh cụ thể; (3) xác định đường đi nào khả thi — khó vì đòi hỏi phân tích điều kiện nhánh. Đây chính là lý do không công cụ đơn lẻ nào đạt recall hoàn hảo mà vẫn giữ FP thấp.

---

## 1.2. Phân tích tĩnh cho memory leak

Phân tích tĩnh kiểm tra mã nguồn mà không thực thi chương trình, có khả năng bao phủ mọi đường đi lý thuyết. Tuy nhiên, chính ưu điểm này cũng là điểm yếu: phân tích quá thận trọng sẽ tạo ra nhiều cảnh báo sai (false positive).

### 1.2.1. Clang Static Analyzer

Clang Static Analyzer [1] sử dụng kỹ thuật symbolic execution trên CFG (Control Flow Graph) để theo dõi trạng thái bộ nhớ. Công cụ này cài đặt các checker chuyên biệt cho từng loại lỗi: `unix.Malloc` cho leak C, `cplusplus.NewDelete` cho leak C++. Ưu điểm lớn nhất là tích hợp sẵn trong toolchain Clang, không cần cài đặt thêm.

Tuy nhiên, Clang SA có giới hạn rõ rệt. Trên benchmark LAMeD [21] gồm 43 leak từ 7 dự án thực, Clang SA phát hiện được 0 leak — `unix.Malloc` không mô hình hoá được factory allocator và interprocedural ownership. Trên Juliet CWE-401 (corpus dễ hơn), Clang đạt F1 khoảng 0.76 với 12 false positive [1]. Con số này cho thấy khoảng cách lớn giữa công cụ tĩnh truyền thống và bài toán thực tế.

### 1.2.2. Facebook Infer

Infer [2] dựa trên lý thuyết separation logic và kỹ thuật biabduction để suy luận trạng thái bộ nhớ qua biên hàm. Điểm mạnh là khả năng phân tích interprocedural mà không cần phân tích lại toàn bộ caller khi callee thay đổi — rất phù hợp cho CI/CD.

Infer hoạt động tốt trên các pattern đơn giản (null pointer, resource leak) nhưng gặp khó với leak phức tạp đòi hỏi theo dõi nhiều biến cùng lúc. Trên benchmark LAMeD [21], Infer chỉ phát hiện 3 leak trong khi CodeQL tìm được 19.

### 1.2.3. CodeQL

CodeQL [3] dùng Datalog để truy vấn quan hệ giữa các phần tử code. Đối với CWE-401, các query tiêu chuẩn theo dõi dòng dữ liệu từ `malloc`/`new` đến điểm sử dụng cuối cùng, kiểm tra xem có đường nào dẫn đến `free()` hay không.

CodeQL mạnh ở tính linh hoạt — người dùng có thể viết query tuỳ chỉnh — nhưng đòi hỏi chuyên môn cao. Trên LAMeD benchmark, CodeQL tìm được 5–10 leak (khi có annotation từ LLM [21]) nhưng tạo ra 139–653 warnings, tỉ lệ FP rất cao.

### 1.2.4. Tree-sitter

Tree-sitter [4] là bộ phân tích cú pháp tăng trưởng (incremental parser) được thiết kế cho các editor và công cụ phân tích code. Khác với Clang (cần compile đầy đủ), Tree-sitter parse trực tiếp mã nguồn thành AST, nhanh và nhẹ hơn nhiều.

Trong luận văn này, Tree-sitter đóng vai trò backbone cho phân tích tĩnh: xác định phạm vi hàm, phân loại kiểu cấp phát, xây dựng CFG cơ bản. Lựa chọn này cho phép phân tích code C/C++ mà không cần compile — quan trọng khi làm việc với các dự án chưa biết cách build.

### 1.2.5. NESA — phân tích tĩnh neuro-symbolic

NESA [5] (Neuro-Symbolic Static Analysis) kết hợp LLM với phân tích tĩnh dựa trên Datalog hạn chế. Hệ thống chia bài toán thành các bài toán con đơn giản hơn, dùng LLM để suy luận từng bước, giảm hallucination qua prompting tăng dần (lazy and incremental prompting).

Kết quả trên TaintBench: precision 66.27%, recall 78.57%, F1 0.72 — vượt phương pháp công nghiệp 0.20 điểm F1. Đặc biệt, NESA phát hiện 13 leak thực đã được nhà phát triển sửa. Đây là minh chứng sớm cho hướng neuro-symbolic trong phân tích memory safety.

### 1.2.6. CodeChecker và khả năng mở rộng

Horvath và cộng sự [6] nghiên cứu cách mở rộng Clang Static Analyzer cho codebase lớn qua framework CodeChecker. Các kỹ thuật bao gồm: phân tích tăng trưởng (chỉ phân tích phần code thay đổi), ức chế FP tự động, tích hợp CI/CD, và khai thác kết quả qua pattern discovery. Nghiên cứu cho thấy các kỹ thuật này tương tác và bổ trợ lẫn nhau, tạo ra hệ thống lớn hơn tổng các phần.

### 1.2.7. Abstract interpretation và symbolic execution

Bên cạnh các công cụ cụ thể, cần nhắc đến hai nền tảng lý thuyết đứng sau phân tích tĩnh: abstract interpretation và symbolic execution.

Abstract interpretation — khởi nguồn từ công trình của Cousot và Cousot (1977) — cho phép suy luận tính chất chương trình bằng cách "trừu tượng hoá" giá trị biến thành các domain đơn giản hơn (ví dụ: interval, sign, parity). Frama-C/Eva và Astrée là hai analyzer tiêu biểu dùng kỹ thuật này cho C; Goblint chuyên về phân tích concurrency. Ưu điểm: soundness có thể chứng minh (mọi bug trong abstract domain đều có bug trong concrete domain). Nhược điểm: over-approximation tạo FP — lý do chính khiến abstract interpretation hiếm khi dùng trực tiếp cho leak detection mà thường phục vụ cho chứng minh absence of bug.

Symbolic execution (King, 1976; Cadar et al., KLEE 2008) chạy chương trình với giá trị biểu tượng thay vì concrete, khám phá nhiều đường đi bằng cách fork tại mỗi branch. Clang SA [1] chính là một partial symbolic executor trên CFG. Điểm mạnh: precision cao hơn abstract interpretation. Điểm yếu: path explosion — số đường tăng exponential với số branch. KLEE và các công cụ kế nhiệm (Manticore, Angr) dùng heuristic search và constraint solving (SMT) để kiểm soát explosion.

Trong ngữ cảnh memory leak, abstract interpretation thường quá thận trọng (mọi cấp phát đều có thể leak → FP cao), còn symbolic execution tốn kém để chạy trên codebase lớn. Cách tiếp cận trong luận văn nằm ở giữa: dùng Tree-sitter [4] parse AST nhẹ (không symbolic), kết hợp guard-subset reconciliation để đạt một phần path-sensitivity mà không cần SMT — đổi precision lấy scalability.

---

## 1.3. Phân tích động cho memory leak

Phân tích động thực thi chương trình và quan sát hành vi thực tế. Ưu điểm là FP thấp (phát hiện leak trên đường thực sự chạy), nhưng nhược điểm là coverage phụ thuộc vào test case.

### 1.3.1. Valgrind Memcheck

Valgrind [7] sử dụng kỹ thuật dynamic binary instrumentation, chèn mã kiểm tra vào binary khi thực thi. Memcheck — tool mặc định — theo dõi mọi lần cấp phát và giải phóng, báo cáo leak khi chương trình kết thúc.

Valgrind đáng tin cậy nhưng rất chậm (10–50× overhead). Trên Linux, đây là tiêu chuẩn de facto cho kiểm tra memory leak. Tuy nhiên, Valgrind chỉ phát hiện leak trên đường thực thi thực sự — nếu test case không chạy đến đường lỗi, leak trên đường đó sẽ bị bỏ sót.

### 1.3.2. AddressSanitizer và LeakSanitizer

ASan [8] chèn mã kiểm tra tại compile-time, sử dụng "redzones" xung quanh vùng cấp phát để phát hiện buffer overflow, use-after-free, và double-free. LSan tích hợp trong ASan, kiểm tra leak tại thời điểm chương trình kết thúc.

ASan nhanh hơn Valgrind đáng kể (khoảng 2× slowdown) nhưng cần compile lại với flag `-fsanitize=address`. LSan đặc biệt hữu ích vì báo cáo chính xác vùng nhớ nào bị rò rỉ và stack trace dẫn đến lệnh cấp phát.

Một lưu ý kỹ thuật quan trọng: ASan/LSan dự trữ khoảng 20 TB địa chỉ ảo, nên cần bỏ giới hạn `ulimit -v`. Không có `llvm-symbolizer`, frame leak sẽ không có `file:line` và không thể tương quan với candidate tĩnh.

### 1.3.3. RangeSanitizer

Gorter và Giuffrida [9] đề xuất RSan, một sanitizer mới sử dụng redzone kết hợp với per-object metadata và pointer tagging. RSan đạt overhead trung bình 44% trên SPEC CPU2017 — nhanh gấp đôi ASan — đồng thời cải thiện throughput fuzzing lên đến 70% khi kết hợp với AFL++.

Đây là bước tiến đáng kể: sanitizer nhanh hơn đồng nghĩa với khả năng chạy nhiều test case hơn trong cùng thời gian, cải thiện coverage.

### 1.3.4. QMSan

Marini và cộng sự [10] phát triển QMSan để phát hiện lỗi sử dụng bộ nhớ chưa khởi tạo (use-of-uninitialized-memory). Hệ thống kết hợp QEMU dynamic binary translation với cơ chế học lọc FP qua các lần fuzzing. Kết quả: phát hiện 44 lỗi mới trong 10 dự án open-source và 5 phần mềm thương mại, với overhead 1.51×, zero FP và zero FN.

Điểm đáng chú ý là QMSan không cần compile lại toàn bộ thư viện — một lợi thế thực tế khi phân tích dự án lớn với dependency phức tạp.

### 1.3.5. CombiSan

Marini và cộng sự [11] tiếp tục đề xuất CombiSan, thống nhất nhiều sanitizer (ASan, MSan, UBSan) thành một runtime duy nhất. Hệ thống duy trì "violation map" để đạt độ chính xác tương đương chạy từng sanitizer riêng lẻ, nhưng chỉ cần một lần fuzzing pass thay vì nhiều lần.

### 1.3.6. AirTaint — taint analysis nhanh hơn

Sang và cộng sự [12] đề xuất AirTaint, kết hợp basic-block-level taint rules với assembly-code-level instrumentation. Hệ thống đạt tốc độ nhanh hơn 931 lần so với libdft, 5.97 lần so với SelectiveTaint, và 328.3 lần so với TaintRabbit. AirTaint phát hiện tất cả 14 CVE trong 9 ứng dụng thực.

### 1.3.7. Fuzzers vs Static Analyzers — hai thế giới gần như không giao nhau

Hassler và cộng sự [13] thực hiện nghiên cứu so sánh thực nghiệm giữa 5 static analyzer và 13 fuzzer trên hơn 100 lỗ hổng C/C++ đã biết. Phát hiện quan trọng: fuzzers tìm được tập bug gần giống nhau (nhiều tool cùng tìm 1 bug), trong khi static analyzer tìm được tập bug khác biệt hơn. Đáng chú ý, tập bug mà fuzzers tìm được và tập bug mà static analyzer tìm được **gần như không giao nhau**.

Kết luận này biện minh trực tiếp cho kiến trúc hybrid trong luận văn: kết hợp static + dynamic để bao phủ nhiều loại leak hơn bất kỳ phương pháp đơn lẻ nào.

---

## 1.4. LLM cho phát hiện lỗi phần mềm

Sự xuất hiện của các mô hình ngôn ngữ lớn (LLM) như GPT-4, Claude, và các model open-source đã mở ra hướng tiếp cận mới cho phát hiện lỗi: thay vì dựa hoàn toàn vào rule cứng, LLM có thể "đọc" code, hiểu ngữ nghĩa, và suy luận về khả năng xảy ra lỗi.

### 1.4.1. Khả năng hiểu code của LLM

Khare và cộng sự [15] đánh giá 16 pre-trained LLM trên 5.000 mẫu code từ 5 dataset khác nhau, bao gồm cả Java và C/C++, trải rộng 25 loại lỗ hổng. Kết quả trung bình: accuracy 62.8%, F1 0.71. LLM hoạt động tốt hơn trên các lỗ hổng chỉ cần phân tích trong một hàm (intra-procedural), kém hơn trên lỗ hổng cần theo dõi qua nhiều hàm.

Một phát hiện đáng chú ý: kỹ thuật prompting "step-by-step analysis" cải thiện F1 lên đến 0.18 điểm. Điều này gợi ý rằng cách đặt câu hỏi cho LLM quan trọng không kém năng lực của model.

### 1.4.2. LLM kết hợp công cụ: ReAct và tool-augmented reasoning

Trước khi bàn đến các hệ thống cụ thể, cần hiểu paradigm đứng sau: làm thế nào LLM sử dụng công cụ bên ngoài?

Yao và cộng sự [28] đề xuất ReAct (Reasoning + Acting), trong đó LLM xen kẽ reasoning traces (suy luận về bước tiếp theo) và actions (gọi công cụ bên ngoài như search API, code interpreter). Khác với chain-of-thought thuần (chỉ reasoning), ReAct cho phép model "hành động" — đọc kết quả thực từ môi trường rồi điều chỉnh suy luận. Trên HotpotQA và Fever, ReAct vượt imitation learning và RL 10–34% absolute success rate.

ReAct là nền tảng cho mọi hệ thống agentic trong phần sau: RepoAudit [25], FuzzingBrain V2 [26], SAILOR [24] đều interleaving reasoning và tool-calling. Trong luận văn, orchestrator dùng native tool-calling (tool_use/tool_result) thay vì ReAct text parsing — nhưng nguyên tắc "suy luận → hành động → quan sát → suy luận lại" giống hệt.

### 1.4.3. IRIS — LLM kết hợp static analysis

Li và cộng sự [16] xây dựng IRIS, hệ thống kết hợp LLM với static analysis để phát hiện lỗ hổng bảo mật trên toàn repository. LLM suy luận taint specification (nguồn và đích của dòng dữ liệu bất an toàn) mà không cần người viết specification thủ công.

Trên CWE-Bench-Java (120 lỗ hổng đã xác minh), CodeQL phát hiện 27 lỗ hổng; IRIS với GPT-4 phát hiện 55 — tăng 28 lỗ hổng. Đặc biệt, IRIS tìm được 4 lỗ hổng mới mà không công cụ nào khác phát hiện. Đây là minh chứng mạnh mẽ cho hướng LLM-augmented static analysis.

### 1.4.3. Prompting như proxy cho static analysis

Ceka và cộng sự [17] đặt câu hỏi táo bạo: liệu LLM prompting có thể thay thế static analysis không? Họ đề xuất kỹ thuật kết hợp hướng dẫn vulnerability bằng ngôn ngữ tự nhiên với chain-of-thought reasoning sử dụng mẫu đối chiếu (contrastive samples).

Kết quả: security-aware prompting vượt baseline static analysis, cải thiện accuracy lên 31.6%, F1 lên 71.7%, và giảm false negative rate 37.6%. Nghiên cứu này cho thấy prompting chiến lược có thể khai thác khả năng reasoning của LLM mà không cần fine-tuning.

### 1.4.4. VulnLLM-R — LLM chuyên biệt cho vulnerability detection

Nie và cộng sự [18] huấn luyện model 7B chuyên biệt cho vulnerability detection, nhấn mạnh reasoning về trạng thái chương trình. Quy trình bao gồm chọn lọc dữ liệu, tạo dữ liệu reasoning, và tối ưu hoá test-time.

VulnLLM-R vượt cả CodeQL và AFL++ trên các dự án thực, phát hiện zero-day trong các repository đang hoạt động. Điều đáng chú ý là model nhỏ (7B parameter) nhưng được huấn luyện đúng cách có thể cạnh tranh với model lớn hơn nhiều.

### 1.4.5. SemTaint — multi-agent taint specification

Ghebremichael và cộng sự [19] xây dựng SemTaint, hệ thống multi-agent kết hợp LLM với static analysis để trích xuất taint specification. Hệ thống sử dụng static analysis để tính call graph, sau đó giao cho LLM phân loại source, sink, và xác định các call edge không giải quyết được.

Tích hợp với CodeQL, SemTaint phát hiện 106 trong 162 lỗ hổng mà CodeQL không thể phát hiện, và tìm được 4 lỗ hổng mới trong các npm package phổ biến. Dù nghiên cứu tập trung vào JavaScript, kỹ thuật này có thể áp dụng cho C/C++.

### 1.4.6. MemHint — neuro-symbolic cho memory leak

Huang và cộng sự [20] xây dựng MemHint, hệ thống kết hợp LLM với Z3 SMT solver để phát hiện memory leak trong C/C++. Pipeline gồm ba bước: (1) LLM phân loại hàm thành allocator, deallocator, hoặc neither; (2) Z3 xác minh tính khả thi của leak path dựa trên CFG; (3) LLM xác nhận kết quả cuối cùng.

Trên 8 dự án thực (3.6M+ dòng code), MemHint phát hiện 54 leak (53 đã được xác nhận và sửa), với chi phí khoảng $1.70 mỗi leak phát hiện. So sánh: CodeQL tìm 19, Infer tìm 3. Đây là kết quả ấn tượng, nhưng MemHint chưa được peer-review (arXiv preprint).

### 1.4.7. LAMeD — LLM annotation cho analyzer cổ điển

Shemetova và cộng sự [21] đề xuất hướng tiếp cận khác: thay vì dùng LLM trực tiếp phát hiện lỗi, dùng LLM để tạo annotation cho analyzer cổ điển. LLM sinh metadata về hàm nào là allocator, hàm nào là deallocator, sau đó feed vào CodeQL, Infer, hoặc Cooddy.

Đây là baseline peer-reviewed duy nhất (EASE 2025, CORE-A) cho leak C/C++. Trên benchmark cJSON, LAMeD đạt P=0.933, R=0.583 (28 TP, 2 FP, 20 FN). Kết quả cho thấy đánh đổi kinh điển: recall tăng thì FP cũng tăng.

### 1.4.8. Revelio — agentic với sanitizer proof

Hou và cộng sự [23] xây dựng Revelio, hệ thống agentic phát hiện memory safety vulnerability ở quy mô repository. Điểm độc đáo: Revelio chỉ báo cáo lỗ hổng có thể tái hiện bằng sanitizer — giảm hallucination bằng cách yêu cầu "bằng chứng thực thi" (executable proof-of-vulnerability).

Trên 7 dự án production (đã fuzz 5–8 năm), Revelio phát hiện 19 lỗ hổng mới, tổng chi phí $300. Hệ thống vượt các frontier coding agent ở cùng chi phí token.

### 1.4.9. SAILOR — symbolic execution với LLM

Shafiuzzaman và cộng sự [24] kết hợp static analysis với LLM để tự động xây dựng harness cho symbolic execution. Ba giai đoạn: static analysis → LLM orchestration (với iterative refinement) → concrete replay xác nhận.

Trên 10 dự án C/C++ (6.8M dòng code), SAILOR phát hiện 379 lỗ hổng memory safety mới, xác nhận 421 crash. Baseline mạnh nhất (Claude Code với agentic vulnerability detection) chỉ tìm được 12. Khi bỏ static analysis, số lỗ hổng giảm 12.2 lần; khi bỏ iterative LLM synthesis, giảm xuống 0.

### 1.4.10. Hệ thống multi-agent cho software engineering

Bên cạnh các hệ thống đơn agent, một hướng nghiên cứu khác là phối hợp nhiều agent cùng làm việc. Guo và cộng sự [33] tổng hợp toàn cảnh: từ ChatDev (mô phỏng công ty phần mềm với agent CEO/CTO/programmer/tester), MetaGPT (SOP encoded vào prompt, assembly-line paradigm), đến Mixture-of-Agents (layered architecture, mỗi layer tổng hợp output từ layer trước).

Trong lĩnh vực vulnerability discovery, hai hệ thống nổi bật:

**RepoAudit** [25] (Guo et al., ICML 2025 poster) là agentic code auditor theo dõi data-flow qua nhiều file trong repository. Agent tự khám phá codebase, sinh audit hypothesis, rồi validate finding. Trên 15 dự án, RepoAudit đạt precision 78.43% (40 TP/11 FP) với chi phí $2.54/dự án. Điểm đáng học hỏi: validator module kiểm tra path-condition SAT để giảm FP — tương tự tầng judge trong luận văn.

**FuzzingBrain V2** [26] (Sheng et al., 2026) là multi-agent system trên MCP gần nhất với kiến trúc luận văn: static analysis (Fuzz Introspector) + dynamic (libFuzzer + ASan) + Claude Opus/Sonnet/Haiku multi-agent. Trên AIxCC 2025 Final (40 vuln/12 dự án), đạt 90% detection rate và phát hiện 29 zero-day. Khác biệt then chốt: xác minh bằng crash sanitizer — leak chỉ là incidental (5 ca). Luận văn mở rộng sang non-crash leak (bằng chứng LSan/Valgrind, không cần crash).

**ATLANTIS** [27] (Team Atlanta, vô địch AIxCC 2025) là hệ thống CRS (Cyber Reasoning System) kết hợp multi-language fuzzer với LLM-based vulnerability analysis. Buttercup (Trail of Bits, hạng 2) dùng dynamic + multi-agent + MCP, open-source AGPL-3. Cả hai xác minh bằng crash → tương phản với lớp non-crash leak mà luận văn nhắm đến.

Hai hệ thống non-agentic cũng đáng chú ý: SWE-agent [34] (Yang et al., 2024) đạt 12.5% pass@1 trên SWE-bench nhờ thiết kế Agent-Computer Interface (ACI) tốt; Agentless [35] (Xia et al., 2024) đạt 32% trên SWE-bench với pipeline đơn giản 3 bước (localize → repair → validate) — không cần agent phức tạp mà vẫn vượt nhiều hệ thống agentic. Bài học: thiết kế pipeline rõ ràng quan trọng hơn mức độ "tự chủ" của agent.

---

## 1.5. Cơ chế đồng thuận và giảm phương sai LLM

### 1.5.1. Self-consistency decoding

Wang và cộng sự [29] đề xuất phương pháp self-consistency: thay vì lấy một đường reasoning (greedy decoding), lấy mẫu nhiều đường reasoning độc lập rồi chọn câu trả lời nhất quán nhất (majority vote). Trên GSM8K, phương pháp này cải thiện CoT +17.9%; trên SVAMP +11.0%.

Ý tưởng cốt lõi: bài toán phức tạp có thể giải bằng nhiều cách khác nhau, và các cách đúng thường hội tụ về cùng đáp án. Đây là nền tảng lý thuyết cho consensus judge trong luận văn.

### 1.5.2. LLM-as-judge: calibration và dao động

Zheng và cộng sự [36] chỉ ra rằng GPT-4-as-judge đạt hơn 80% đồng thuận với chuyên gia con người — tương đương tỉ lệ đồng thuận giữa hai người. Tuy nhiên, nghiên cứu cũng phát hiện các bias: position bias (thiên vị vị trí), verbosity bias (thiên vị câu dài hơn), và self-enhancement bias (model tự đánh giá mình cao hơn).

Trong ngữ cảnh memory leak, vấn đề lớn hơn là dao động run-to-run: cùng một prompt, cùng model, cùng temperature=0, nhưng verdict có thể khác nhau giữa các lần chạy do provider-side batching. Đây chính là vấn đề mà consensus judge trong luận văn nhắm giải quyết.

### 1.5.3. McNemar test cho paired comparison

Khi so sánh hai hệ thống trên cùng corpus, McNemar test là phương pháp thống kê phù hợp — kiểm tra xem tỉ lệ "A đúng, B sai" có khác biệt đáng kể so với "B đúng, A sai" hay không. Đây là test paired, mạnh hơn so sánh aggregate F1 đơn lẻ.

---

## 1.6. Benchmarks và datasets

### 1.6.1. Juliet Test Suite (NIST)

Juliet Test Suite v1.3 [37] là bộ test tiêu chuẩn của NIST cho C/C++, bao gồm 118 CWE. Riêng CWE-401 chứa khoảng 1.820 test cases (kết hợp biến thể bad và good). Mỗi file test chứa hàm `bad()` (leak) và một hoặc nhiều hàm `good1()`, `good2()` (không leak).

Mã hoá tên file phân loại biến thể: loại cấp phát (`malloc`, `calloc`, `realloc`, `new`, `strdup`), kiểu dữ liệu (`char`, `int`, `struct`, `wchar_t`), và số lượng phần tử. Đây là corpus tiêu chuẩn cho đánh giá static analysis tool.

Hạn chế lớn nhất: code Juliet là synthetic, pattern có công thức, không phản ánh độ phức tạp của dự án thực. Dù vậy, Juliet vẫn hữu ích cho ablation study vì ground-truth rõ ràng.

### 1.6.2. LAMeD Benchmark

LAMeD benchmark [38] (Zenodo 15089703) gồm 36 entry từ 7 dự án open-source thực: curl (14), libtiff (6), libsolv (6), cjson (6), libxml2 (4), libssh2 (3), rabbitmq-c (2). Mỗi entry chứa link đến phiên bản lỗi, commit sửa lỗi, và file bị ảnh hưởng.

Đây là benchmark leak C/C++ thực tế duy nhất có ground-truth function-level. Hạn chế: chỉ có positive (leak), không có negative (code sạch), nên chỉ đánh giá được recall và FP count, không tính được specificity hay accuracy.

### 1.6.3. DiverseVul

DiverseVul [39] là dataset vulnerability lớn nhất cho C/C++ tại thời điểm công bố: 330.492 hàm (18.945 vulnerable), 150 CWE, từ 295+ dự án. Dữ liệu được crawl từ security issue websites, trích xuất vulnerability-fixing commits.

Nghiên cứu đánh giá 11 model thuộc 4 họ kiến trúc và kết luận: "deep learning vẫn chưa sẵn sàng cho vulnerability detection, do FP cao và F1 thấp." Tuy nhiên, LLM được đánh giá là "hướng nghiên cứu đầy hứa hẹn."

### 1.6.4. SV-COMP Memsafety

SV-COMP [29] là cuộc thi thường niên đánh giá công cụ verification trên C, bao gồm category memsafety với các thuộc tính: không leak, không buffer overflow, không null deref, không use-after-free. Chương trình có cả biến thể an toàn và không an toàn với kết quả mong đợi.

### 1.6.5. Magma

Magma [30] là benchmark fuzzing sử dụng ground-truth, chèn bug thật (bao gồm leak) vào chương trình thật (libpng, libtiff, SQLite, OpenSSL). Bug trigger từ CVE đã biết, cho phép đánh giá chính xác khả năng phát hiện của công cụ.

---

## 1.7. Tổng kết và vị trí nghiên cứu

Bảng sau tổng hợp các hệ thống liên quan và vị trí của luận văn:

| Hệ thống | Static | Dynamic | Agentic | Judge | Leak focus | Peer-review |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Clang SA [1] | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Infer [2] | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| CodeQL [3] | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| MemHint [20] | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ |
| LAMeD [21] | ✅ | ❌ | ❌ | 🟡 | ✅ | ✅ |
| Revelio [23] | ✅ | ✅ | ✅ | ✅ | 🟡 | ❌ |
| SAILOR [24] | ✅ | ✅ | ✅ | ❌ | 🟡 | ❌ |
| IRIS [15] | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Đề tài** | **✅** | **✅** | **✅** | **✅** | **✅** | **—** |

Khoảng trống rõ ràng: **chưa có hệ thống nào kết hợp LLM orchestration + static + dynamic chuyên cho memory leak C/C++.** MemHint và LAMeD chỉ dùng static; Revelio và SAILOR nhắm crash/vulnerability nói chung, không chuyên leak. Đồ thị Venn giữa "static + dynamic" và "memory leak focus" vẫn còn trống — đó chính là vị trí của luận văn này.

---

*Xem danh sách tham khảo đầy đủ trong `paper/references/bibliography.md`.*
