# Chương 5: Kết luận và hướng phát triển trong tương lai

Năm chương đã đi qua: từ bối cảnh memory leak trong C/C++ (Chương 1), qua thiết kế kiến trúc HYBRID pipeline (Chương 2), hiện thực hoá hệ thống (Chương 3), đến đánh giá thực nghiệm trên hai corpus (Chương 4). Chương cuối cùng này tổng kết câu trả lời cho bốn câu hỏi nghiên cứu, bàn luận ý nghĩa của kết quả, và chỉ ra hướng phát triển.

---

## 5.1. Trả lời câu hỏi nghiên cứu

### RQ1: LLM orchestration có cải thiện hiệu suất phát hiện leak không?

Câu trả lời phụ thuộc vào độ khó của corpus.

Trên Juliet CWE-401 (corpus synthetic, code pattern có công thức), cấu hình heuristic thuần (B6a) cho kết quả tốt nhất: F1 0.938. Thêm LLM judge (B7) không cải thiện — thậm chí F1 giảm nhẹ (0.929) vì agentic tool_selector lãng phí token vào những cuộc gọi không cần thiết. Lý do: Juliet produce "non-borderline" bundles, heuristic finalize hết trước khi LLM judge engage.

Trên LAMeD benchmark (dự án thực: curl, cjson, libtiff...), hệ thống vượt Clang SA: 12/41 leak bắt được (FP=0) so với 0/43. LLM allocator profiler khám phá factory allocator mà hardcode bỏ sót. Path-sensitive heuristic bắt leak parameter-ownership đầu tiên (cjson `merge_patch`).

Kết luận: trên corpus dễ, heuristic đủ mạnh; trên corpus khó, LLM orchestration mở rộng khả năng phát hiện mà không tăng FP. Đây là kết quả trung thực — không phóng đại hiệu quả LLM trên corpus không phù hợp.

### RQ2: Bằng chứng dynamic có giảm FP không?

Có, và đây là phát hiện rõ ràng nhất. B4 (LLM + static, không dynamic) có 18 FP. B6 (+dynamic) giảm xuống 1 FP. Dynamic là "FP killer": bằng chứng sanitizer xác nhận hoặc phủ nhận leak candidate mà static over-report. FP=1 ổn định ở mọi cấu hình có dynamic.

Điều này biện minh cho kiến trúc hybrid: static cast net rộng (recall cao), dynamic xác nhận (FP thấp). Không có dynamic, ngay cả LLM judge cũng không refute được static over-report.

### RQ3: Consensus voting có giảm dao động verdict không?

Có. Single-LLM flip rate: 13–27%. Consensus K=3: 6.7%. Giảm 2–4 lần. Kết quả replicated chính xác qua hai campaign (6.7% / 93.3% / 96.7% cả hai lần) — tính chất ổn định, không phải số may.

McNemar test (p=0.45) chưa có ý nghĩa thống kê ở n=30, nhưng xu hướng rõ ràng: 5 site nghiêng về consensus, chỉ 2 nghiêng về single. Cần corpus lớn hơn hoặc hard hơn để khẳng định theo paired test.

### RQ4: Hệ thống hoạt động ra sao trên dự án thực?

Trên LAMeD (41 leak từ 7 dự án), hệ thống đạt Precision 1.0, Recall 0.273. Clang Static Analyzer đạt 0/43. Recall 0.273 nghĩa là 12/41 leak bắt được — nằm trong dải LAMeD tự báo cho công cụ có annotation (5–10/43).

Thành quả cụ thể: leak đầu tiên bắt được trên dự án thực là `cJSON_merge_patch` — rò rỉ tham số `target` trên đường lỗi, phát hiện qua guard-subset reconciliation + parameter-ownership scoring. Đây là minh chứng end-to-end cho pipeline từ discovery đến verdict.

---

## 5.2. Đóng góp của luận văn

**C1 — Consensus judge.** Hệ thống consensus đầu tiên kết hợp static+dynamic evidence với self-consistency voting cho leak C/C++. Không chỉ bỏ phiếu, mà còn có precision-override veto (heuristic phủ quyết khi tự tin miễn tội) và escalation theo bất đồng (leo thang khi static↔dynamic mâu thuẫn).

**C2 — Giao thức tái lập hai tầng.** Tier-1 (no_llm, bitwise) cho baseline reproducible; Tier-2 (llm_assisted, mean±std + verdict-stability) cho đánh giá công bằng. Determinism gate chống "đậu giả" — đã từ chối đúng hai kiểu lỗi gặp thật trong quá trình phát triển.

**C3 — Tất định hoá dynamic.** Recipe `buildTarget→lsanRun` ghim, không LLM trong loop chạy → coverage tất định → verdict tái lập. Bắt buộc khi LLM sub-agent dynamic từng gây dao động run-to-run.

**C4 — Evidence enrichment có cấu trúc.** Ownership summaries, alloc→free pairs, feasible leak paths, dynamic correlation (LINKED vs file-only vs unlinked). Mọi verdict truy vết được về bằng chứng cụ thể trong snapshot.

---

## 5.3. Bàn luận

### Juliet là corpus dễ

Đây là caveat lớn nhất. Juliet code có pattern công thức: hàm `bad()` luôn leak, hàm `good()` không bao giờ. Heuristic judge — vốn dựa trên tín hiệu cấu trúc — hoạt động tốt trên code đơn giản. Kết quả F1 0.938 trên Juliet không đại diện cho performance trên dự án thực.

Agentic tool_selector counter-productive trên corpus dễ: F1 0.929 @ 4,24M token so với B6a F1 0.938 @ 463k token. Chi phí gấp 9 lần cho kết quả kém hơn. Câu hỏi mở: trên corpus khó (dự án thực với control-flow phức tạp), agentic exploration có bù đắp được chi phí?

### Dynamic là FP killer

B4 (static+LLM, no dynamic): 18 FP. B6 (+dynamic): 1 FP. Đây là kết quả có ý nghĩa thực tiễn lớn nhất. Runtime sanitizer cung cấp bằng chứng mà static analysis không thể: leak có thật sự xảy ra không? Một candidate static over-report nhưng dynamic chạy sạch → heuristic tự tin kết luận false positive.

### Path-sensitive: heuristic CFG vs SMT

Bật static enrichment (path-sensitive) trên Juliet: FP tăng từ 7 lên 44. Guard-subset reconciliation quá thận trọng — mọi `if (p == NULL) return` đều bị coi là feasible leak path. Z3 SMT solver từng giảm FP 44→8 (vì `p!=0 ∧ p==0` = UNSAT), nhưng bị loại khỏi kiến trúc do trần heap 2 GiB WASM. SMT in-process là bất khả thi.

Kết luận: path-sensitive detection cần feasibility chính xác, nhưng SMT quá nặng. Giải pháp thay thế: hybrid static+dynamic + consensus judge (chính là đóng góp luận văn). Opt-in `STATIC_ENRICH=on` cho người dùng chấp nhận recall cao hơn với FP cao hơn.

### Chi phí token

Tổng sweep 9 baseline: 10,6 triệu token. B6a (winner): 463k. B7 (full adaptive): 4,12M. B6b (agentic tool_selector): 4,24M. Agentic chiếm 79% tổng chi phí cho F1 thấp hơn. Sweet spot: B6a — planner + deterministic recipe + LLM judge.

### LLM-as-judge: bản chất non-deterministic

Ngay cả temperature=0, LLM không bit-deterministic do provider-side batching. Consensus giảm flip rate 4× nhưng không loại bỏ hoàn toàn. Đây là giới hạn fundamental của LLM, không phải lỗi implementation.

---

## 5.4. Threats to validity

**Corpus synthetic.** Juliet có pattern công thức — kết quả F1 0.938 không phản ánh performance trên code thực. LAMeD (41 ca, positive-only) là corpus thực duy nhất — quá nhỏ để draw strong conclusions.

**Single model.** Chỉ đánh giá trên `mimo/mimo-v2.5-pro`. Kết quả có thể khác với GPT-4o, Claude, Gemini. Multi-model evaluation là hướng cần mở rộng.

**Baseline mỏng.** Chỉ LAMeD (EASE 2025) là peer-reviewed đầy đủ. MemHint, Revelio, SAILOR là preprint. RepoAudit là poster. Baseline so sánh trực tiếp (cùng corpus, cùng scorer) chỉ có Clang SA.

**Real-project recall thấp.** 0.273 (12/41) — 29/41 leak bị bỏ sót. Phần lớn do deallocator-semantics (2), path-sensitive chưa đủ chính xác (2), và alias/interprocedural phức tạp (25). Đây là giới hạn thực sự, không chỉ là "future work."

---

## 5.5. Hướng phát triển tương lai

**Alias-aware interprocedural dataflow.** Hiện tại, interproceduralFlow theo dõi biến theo tên — không handle alias. Cần pointer analysis (có thể dùng LLVM) để theo dõi con trỏ qua biên hàm chính xác hơn.

**Deallocator semantics modeling.** cJSON_Delete bỏ qua const buffer — đây là semantic mà code thuần không mã hoá. Hướng: LLM đọc implementation của deallocator, suy luận rule, verify bằng grep, cache.

**Harder corpus.** Mở rộng LAMeD (thêm project), xây corpus mới từ CVE database (DiverseVul [10], CVEfixes). Cần cả negative samples (code sạch) để đánh giá precision đầy đủ.

**Multi-model.** Đánh giá GPT-4o, Claude Sonnet, Gemini Flash trên cùng ablation study. Câu hỏi: consensus cross-model (K mẫu từ N model khác nhau) có tốt hơn consensus single-model?

**MCP ecosystem.** Analyzer tool mới từ community có thể plug vào mà không đổi orchestrator. Ví dụ: tool phân tích Rust ownership, tool CVE lookup, tool code review.

**Chi phí optimization.** Cache static analysis results cho file không đổi giữa các run. Giảm LLM calls bằng cách heuristic finalize trước, chỉ escalate borderline thực sự.

**Rust extension.** Rust có borrow checker — ownership information sẵn có. Kết hợp với unsafe code analysis có thể mở rộng hệ thống sang ngôn ngữ an toàn bộ nhớ nhưng vẫn có leak trong unsafe blocks.
