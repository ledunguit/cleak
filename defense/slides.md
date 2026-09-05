# HỆ THỐNG SỬ DỤNG MÔ HÌNH NGÔN NGỮ LỚN ĐIỀU PHỐI HỢP NHẤT PHÂN TÍCH TĨNH - ĐỘNG TRONG PHÁT HIỆN RÒ RỈ BỘ NHỚ C/C++

### Luận văn thạc sĩ

Học viên thực hiện: **Lê Đăng Dũng**

Cán bộ hướng dẫn: **TS. Phan Thế Duy**

Note: Chào hội đồng. Bài trình bày khoảng 22 phút: bài toán, kiến trúc, ba kết quả đinh, tái lập, hạn chế, đóng góp.

---

## Bài toán: rò rỉ bộ nhớ trong C/C++

- Memory leak (CWE-401): bộ nhớ cấp phát không bao giờ được giải phóng
- Không crash ngay: chương trình vẫn chạy, bộ nhớ tăng dần, test thông thường khó tái hiện
- C/C++ để lập trình viên tự quản bộ nhớ; một đường return sớm quên `free()` là đủ để rò
- Hậu quả: service chạy dài bị OOM, hiệu năng suy giảm dần

Note: Slide dựng bối cảnh, chưa có số liệu.

---

## Hai nửa của bài toán, và khoảng trống

| | Tĩnh (Clang SA, Infer) | Động (Valgrind Memcheck, ASan/LSan) |
|---|---|---|
| Cần chạy chương trình | Không | Có |
| Bằng chứng | Suy đoán từ mã, FP cao | Chắc, nhưng chỉ trên đường thực thi |
| Điểm dừng | Cảnh báo | Cảnh báo |

Không tool nào trong hai họ trả lời được: vì sao rò (root-cause) và sửa thế nào (fix)

Note: Khoảng trống root-cause + fix là động cơ của đề tài.

---

## Bốn câu hỏi nghiên cứu

1. **RQ1**: LLM điều phối có cải thiện hiệu suất phát hiện leak không?
2. **RQ2**: Kết quả có tái lập được không?
3. **RQ3**: Consensus voting có giảm dao động verdict không?
4. **RQ4**: Hệ thống hoạt động ra sao trên dự án thực?

Note: RQ1, RQ4 trả lời bằng số; RQ2 bằng giao thức hai tầng; RQ3 có kết quả bất ngờ, dành thời gian riêng ở sau.

---

## Kiến trúc HYBRID 4 tầng

![Kiến trúc HYBRID](../.omo/evidence/thesis-completion-next-steps/figures/fig-arch-academic.png)

*Hình 1. Orchestrator điều phối hai analyzer qua MCP; judge là tầng duy nhất còn LLM sampling*

- A: fan-out sub-agent tĩnh (AST, call graph, ownership)
- B: build + sanitizer chạy theo recipe ghim cứng, không LLM trong vòng chạy
- C: hợp nhất bằng chứng tĩnh + động thành leak bundle
- D: judge heuristic cho mọi bundle; LLM chỉ vào ca biên

Note: Nhấn tầng B: tất định hoá tầng động là quyết định thiết kế then chốt, dẫn tới kết quả tái lập ở sau.

---

## Phương pháp đánh giá

| Corpus | Quy mô | Loại |
|---|---|---|
| Juliet CWE-401 | 1658 ca, hash `f578c3ee` | Tổng hợp, đã validate |
| LAMeD (EASE 2025) | 41 ca / 7 dự án C thật, 50 site | Thực, positive-only |
| MemHint | 19 ca / 6 dự án lớn, tự tái lập | Thực, positive-only |

- 9 baseline B1-B7 (ablation capability), mỗi config LLM chạy 3 lần
- Corpus thật: so sánh được recall + số FP; precision/MCC không định nghĩa vì TN=0

Note: Nguồn: FREEZE groups 1, 4, 10; quy ước positive-only ở docs/BASELINE-COMPARISON.md.

---

## Kết quả đinh 1: Juliet toàn corpus, 1658 ca

Cùng một sweep, cùng commit `5eec8b1`, cùng scorer:

| Cấu hình | P | R | F1 | MCC | Chi phí |
|---|---|---|---|---|---|
| **B6a**: planner + recipe tất định + LLM judge | 0.965 | 0.780 | **0.863±0.001** | 0.790 | $6.63 |
| B1: tĩnh thuần, không LLM | 0.680 | 0.556 | 0.612 | 0.375 | - |

Chênh lệch 0.251 F1 đo trên cùng corpus, cùng thế hệ code

Note: Nguồn: FREEZE group 1 (deepseek-v4-flash, 2026-08-15/16). P/R của B1 khớp chéo bằng run no_llm postfix4 độc lập (group 2).

---

## Kết quả đinh 1 (tiếp): thêm LLM không tự động tốt hơn

Xếp hạng F1 toàn sweep (3 runs cho config LLM):

B6a 0.863 ≈ B6 0.862 > B6b 0.858 ≈ B7 0.856 > B4 0.801 > B3 0.683 > B1 0.612 > B5 ≈ B2 0.392

- B7 agentic đầy đủ: $27.14, khoảng 4 lần B6a, đổi lại F1 0.856 thấp hơn
- Hai config cuối bảng tụt dưới cả baseline tĩnh: LLM đặt sai chỗ còn làm tệ
- Tổng chi phí cả sweep: $75.78

Note: Nguồn: FREEZE group 1. Thông điệp: giá trị nằm ở cách bố trí LLM, không phải số lượng LLM.

---

## Kết quả đinh 2 (1/2): LAMeD, dự án thực

41 ca / 7 dự án C thật, 50 site rò sau khi chỉnh denominator:

- TP15 / FP0 / FN35, recall 30.0%, std=0 trên 3 run
- llm_assisted trùng từng ca với no_llm; LLM judge gọi 47-149 lần mỗi run, không lật verdict nào
- Thêm interproceduralFlow vào đường tĩnh: byte-identical (Δ=0)
- FP=0 phải đọc kèm recall 30%: corpus positive-only, TN=0 theo cách dựng

Note: Nguồn: FREEZE group 4 (commit c5826bc, 2026-08-20); 3 run cho ma trận nhầm lẫn y hệt nên std=0.

---

## Kết quả đinh 2 (2/2): MemHint, corpus thực thứ hai

19 ca / 6 dự án lớn (vim, redis, openssl, freerdp...), ground truth tự tái lập:

- no_llm: TP12 / FP0 / FN14, recall 46.2% (12/26 site)
- llm_assisted ×3 (nhóm fusion-B6): ma trận nhầm lẫn y hệt cả 3 run, F1 0.632±0.000
- Judge heuristic chốt ~17.1k verdict mỗi run; LLM judge chỉ fire 2 site ở run 2, 0 lật
- Chi phí 3 run LLM: ~44.3M token (vào ~26.5M, ra ~17.8M)

Note: Nguồn: FREEZE group 10 (commit 30e04cb1c, 2026-09-05); judge path run 2: {heuristic:17154, llm:2}. Cấu hình là llm_assisted, cùng nhóm fusion-B6 trong sweep.

---

## Hai corpus thật, một kết quả nhất quán

- LAMeD và MemHint cho cùng mẫu: llm_assisted ≡ no_llm ở tầng verdict
- LLM vẫn làm việc thật: allocator profiling, fan-out tĩnh, token tiêu vào đó
- Không bundle nào đủ biên để heuristic phải nhường: hybrid judge đúng thiết kế
- Bài học: LLM judging thêm giá trị khi corpus có ca biên thực sự

Note: Đối chiếu Juliet, nơi LLM judge nâng F1 từ 0.612 lên 0.863 (group 1): corpus synthetic nhiều ca biên, corpus thật heuristic tự tin hơn. Nguồn: groups 1, 4, 10.

---

## Kết quả đinh 3: Clang SA yếu hơn trên cùng corpus, cùng scorer

- Juliet, mẫu stratified n=50: Clang SA ~0.76, thấp hơn B1 tĩnh thuần (0.792) và B6a (0.938±0.015)
- Đối chiếu quy mô: B6a toàn corpus là 0.863, hai con số trả lời hai câu hỏi khác nhau
- LAMeD: Clang SA quét 43 site, TP0 / FN43, tức bắt 0 trên corpus thực
- Mẫu số 43 khác 50 do scorer chấm mỗi hệ trên granularity finding của chính nó, by design

Note: Bảng cùng-corpus: docs/CONTRIBUTION.md, mẫu stratified n=50 (0.938±0.015 là FREEZE group 7, phụ, luôn kèm 0.863 toàn corpus của group 1); Clang trên LAMeD từ group 4.

---

## Phát hiện phương pháp luận (1/2): consensus tưởng thắng

Thí nghiệm đầu, n=30, hai đợt độc lập:

- Single-LLM lật verdict 13.3-26.7%; consensus K=3 lặp y hệt 6.7% qua cả hai đợt
- Kết luận khi đó: consensus ổn định hơn 2-4 lần
- Rồi kiểm tra lại mẫu: n=30 vô tình gồm 100% family `char` của Juliet

Note: Số n=30 từ docs/CONTRIBUTION.md; việc phát hiện lỗi lấy mẫu được kể trung thực như một phần câu chuyện nghiên cứu.

---

## Phát hiện phương pháp luận (2/2): n=50 stratified đảo ngược

Lặp đúng protocol, mẫu stratified đủ 10 family (commit `f0d371c`):

| Nhánh judge | Tỉ lệ lật verdict | F1 |
|---|---|---|
| Single-LLM (k=1) | **2.0%** | **0.852** |
| Consensus (k=3) | 8.0% | 0.793 |

- McNemar trên 205 site ghép cặp: χ²=3.13, p=0.077, xu hướng nghiêng single, chưa đạt ý nghĩa
- Family variance giải thích: F1 0.991 trên malloc nhưng 0.584 trên strdup
- Kết luận: không khuyến nghị consensus mặc định; cách lấy mẫu có thể lật chiều một ablation

Note: Nguồn: FREEZE group 5 (2026-08-19); hai đợt độc lập cho cùng số; family variance từ group 7. Ba mẫu gần như luôn đồng ý thì bỏ phiếu chỉ ổn định hoá thứ chưa từng bất ổn.

---

## Tái lập: giao thức hai tầng

- Tier-1 (`no_llm`): tất định bit-for-bit; gate CI chứng nhận, tự từ chối hai kiểu đậu giả gặp thật (so dir với chính nó, run degenerate)
- Tier-2 (`llm_assisted`): báo phân phối mean±std qua nhiều run, cộng tỉ lệ lật verdict từng ca
- Run no_llm postfix4 toàn corpus: P 68.0% / R 55.6% / F1 0.612 / MCC 0.375, mốc kiểm chứng chéo cho B1
- Bằng chứng vận hành: driver MemHint sống sót VM reboot giữa run qua `--resume`, đủ 19/19 ca; artifacts sha256 byte-identical trước và sau reboot, đã verify

Note: Gate: scripts/determinism-gate.sh + assert-determinism.ts (docs/CONTRIBUTION.md). Bằng chứng vận hành: FREEZE group 10, driver hoàn thành ở attempt 3/8.

---

## Hạn chế

- Juliet tổng hợp là corpus chính; kết quả toàn corpus bị kéo xuống bởi family khó (C++ new/delete, malloc)
- Một model chính (deepseek-v4-flash); hai sweep phụ chỉ là bằng chứng hướng (mimo 0.737, zai 0.774)
- Corpus thực nhỏ và positive-only; FP=0 luôn phải đọc kèm recall
- Parse OOM trên repo rất lớn (redis ~14 GB); std=0 trên corpus thực giới hạn việc diễn giải variance
- 35/50 site LAMeD còn sót thuộc lớp khó: deallocator semantics, path-sensitive, ownership interprocedural

Note: Model phụ: FREEZE group 8 (0.737) và group 9 (0.774, run 1/2 hoàn chỉnh). Std=0: ba run trùng khít, không nói được gì về variance tự nhiên.

---

## Hướng phát triển

- Pointer analysis (LLVM) thay cho theo dõi biến theo tên, nhận diện alias qua biên hàm
- Mô hình hoá deallocator semantics: LLM đọc code, suy rule, grep-verify, cache theo dự án
- Path feasibility chạy ngoài tiến trình; SMT in-process bất khả thi vì trần WASM 2 GiB
- Ablation multi-model thiết kế đầy đủ; corpus khó hơn kèm negative samples
- Tool mới của cộng đồng cắm vào orchestrator qua MCP, không cần sửa hệ

Note: Kế thừa mục 5.5; SMT in-process đã thử thật: z3-solver WASM abort không bắt được, analyzer treo.

---

## Kết luận: bốn đóng góp

- **C1, novelty trung tâm: pipeline hybrid tất định-trừ-judge.** Tầng động ghim recipe, planner chỉ gate luồng, judge là chỗ duy nhất còn sampling. Bằng chứng: F1 0.863 / MCC 0.790 toàn corpus, std=0 trên corpus thật
- **C2: giao thức tái lập hai tầng.** Tier-1 tất định bit-for-bit có gate; Tier-2 báo phân phối
- **C3: làm giàu bằng chứng cho judge.** Ownership, cặp alloc→free, feasible-leak-path, correlationMethod; allocator annotation theo dự án qua LLM profiler
- **C4: consensus judge, kết quả âm trung thực.** Báo cả hai kết quả, không khuyến nghị mặc định, rút bài học sampling

Note: Đánh số khớp docs/CONTRIBUTION.md; số C1 từ FREEZE group 1. C4 là kết quả âm được kể đủ, không phải điểm cần giấu.

---

## Cảm ơn hội đồng

Xin mời câu hỏi và thảo luận.

Note: Câu hỏi khó nhất dự kiến: "vì sao cơ chế đồng thuận trong tên đề tài lại không được khuyến nghị?" Trả lời: mục tiêu là ĐÁNH GIÁ cơ chế; đánh giá nghiêm túc cho kết quả âm có giá trị khoa học; phát hiện chỉ ra hiệu ứng sampling mà nghiên cứu LLM-judge trước đó bỏ qua.

---

## Phụ lục soạn thảo (không trình chiếu)

- 20 slide tổng; trình chiếu S1-S19 (bìa đến cảm ơn), 17 slide nội dung thực, ~22 phút, dư ~3 phút dự phòng; slide cuối chỉ dùng khi soạn thảo
- Phân bổ: mở đầu S1-S4 3:15; kiến trúc + phương pháp S5-S6 2:45; Juliet S7-S8 3:00; corpus thật S9-S11 4:15; Clang S12 1:00; consensus S13-S14 2:30; tái lập S15 1:30; hạn chế + hướng phát triển S16-S17 2:15; kết luận + cảm ơn S18-S19 1:40
- Mọi số truy vết về docs/RESULTS-FREEZE.md; nhóm nguồn (FREEZE group N) ghi ở speaker note từng slide
