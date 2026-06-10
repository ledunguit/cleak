# Baseline KIẾN TRÚC cho leak-investigator (static+dynamic+MCP+judge agentic)

> **Câu hỏi:** "Cùng kiểu kiến trúc thì chắc chỉ có FuzzingBrain V2 là phù hợp nhất?"
> **Trả lời (đã verify):** **FuzzingBrain V2 là khớp NHẤT, nhưng KHÔNG phải DUY NHẤT.** Verdict: `fuzzingbrain-best-others-exist`.

*Phương pháp: workflow săn theo trục kiến trúc — 5 góc tìm kiếm → 38 hệ thống duy nhất → verify đối kháng 3 phiếu cho nhóm top. Ngày: 2026-06-09.*

---

## Chữ ký kiến trúc của leak-investigator (để đối chiếu)

1. **Static** (Clang SA / LeakGuard + AST + call graph + interprocedural flow) — qua **MCP**
2. **Dynamic** (Valgrind Memcheck + ASan + **LSan**) — qua **MCP**
3. **Control-plane** điều phối (vòng lặp agentic: discovery → investigation → judging)
4. **Judge layer** → **verdict + giải thích root-cause + repair diff**
5. Target = **memory LEAK** (lỗi *không gây crash*) trong C/C++

→ Trục **MCP-bọc-cả-static-lẫn-dynamic** là thứ **định nghĩa rõ nhất** leak-investigator. Và đây cũng là trục mà gần như **không** hệ nào khác xác nhận được (trừ FuzzingBrain V2).

---

## Bảng xếp hạng analogue kiến trúc (đã verify)

Ký hiệu chiều: **S**=static · **D**=dynamic · **A**=multi-agent · **M**=MCP · **J**=judge/repair · **C**=C/C++ · **L**=leak

| Hệ thống | Năm | Mức khớp | Chiều xác nhận | Caveat chính |
|---|---|---|---|---|
| **FuzzingBrain V2** | 2026 | 🟢 **Strong** (3/3 strong) | **S D A M J C** | Preprint; **leak chỉ incidental** (~5 ca); judge = reproduce crash (PoC), không phải fuse static+dynamic |
| **ATLANTIS** (Team Atlanta, **vô địch AIxCC 2025**) | 2025 | 🟢 **Strong** (3/3) | S D A J C (M?) | **MCP không xác nhận**; tech report (arXiv 2509.14589); closed-source; không nêu leak |
| **Buttercup** (Trail of Bits, **hạng 2 AIxCC**) | 2025 | 🟢 **Strong** | D A **M**(.mcp.json) J C (S một phần) | **Open-source (AGPL-3.0), chạy được trên laptop** → baseline khả thi nhất; static layer ít tài liệu; không nêu leak |
| **PAGENT** | 2026 | 🟡 Partial (3/3 partial) | S D J C | **Single-agent** (không multi-agent); không MCP; chỉ sinh PoC, không judge+repair; preprint 2604.07624 |
| **ARTIPHISHELL** (Shellphish) | 2025 | 🟡 Partial (weak) | S D A J C | MCP không; static+dynamic chỉ 1/3 phiếu xác nhận; đa ngôn ngữ (Java/Jazzer); platform K8s lớn |
| **RoboDuck** (Theori, hạng 3 AIxCC) | 2025 | 🟡 Partial | S(Infer+LLM) D A J C | **Trường hợp tương phản:** "LLM-first", **cố tình KHÔNG dựa vào fuzzing** → ngược triết lý dynamic-evidence của bạn; blog |
| **FuzzingBrain V1** | 2025 | ⚪ Weak (lineage) | S D A J C | **Không có MCP** (chỉ V2 mới có) → V2 chiếm ưu thế tuyệt đối; dùng V2 |

---

## Vì sao FuzzingBrain V2 đứng đầu (nhưng không một mình)

**Đứng đầu:** là hệ **duy nhất** xác nhận đủ **6 chiều cùng lúc** (S+D+A+M+J+C) và **duy nhất** xác nhận trục **MCP-bọc-cả-static-lẫn-dynamic** (abstract ghi rõ *"MCP-based static and dynamic analysis tools"*). Vì MCP là trục phân biệt sắc nhất, FuzzingBrain V2 đứng **một mình ở đỉnh**.

**Nhưng không duy nhất** — 2 lý do "others-exist" có trọng số:
1. **ATLANTIS** (vô địch AIxCC 2025) đạt cùng mức 3/3 và là **analogue full-pipeline mạnh nhất** (static guide → dynamic/symbolic confirm → triage/verdict → patch giữ ngữ nghĩa). Khớp trục **orchestration+judge+repair** thậm chí *nhỉnh hơn* FuzzingBrain V2 — **khoảng cách duy nhất là MCP chưa xác nhận**.
2. **Buttercup** là analogue **open-source, chạy trên laptop**, có **`.mcp.json` trong repo**, map sạch 5 thành phần (orchestrator / program-model / seed-gen / fuzzer+ASan / multi-agent patcher) → **baseline tái lập được nhất**.

---

## ⚠️ Caveat áp dụng cho TẤT CẢ (gồm cả FuzzingBrain V2)

**Không hệ nào xác nhận target là memory LEAK.** Tất cả đều săn **lỗi gây crash** (UAF/overflow/double-free) — nơi **một crash do sanitizer phát hiện CHÍNH LÀ verdict**. Trong khi đó:
- leak-investigator nhắm **leak *không* gây crash** (chỉ lộ qua **LSan/Valgrind**),
- và judge của bạn **hợp nhất bằng chứng static+dynamic** thành **verdict + giải thích + repair diff**, *giàu hơn* bước reproduce-crash/PoC của họ.

→ Đây vừa là **caveat khi dùng làm baseline**, vừa là **điểm định vị đóng góp** của bạn: *"các hệ agentic static+dynamic hiện có xác minh bằng crash; leak-investigator mở rộng mô hình đó sang lớp lỗi không-crash bằng cách hợp nhất bằng chứng LSan/Valgrind + static trong một judge layer."*

**Trạng thái công bố:** các hệ CRS AIxCC (ATLANTIS/Buttercup/ARTIPHISHELL/RoboDuck) là **tech report / blog / repo**, **không** peer-reviewed → cite dưới dạng *"AIxCC finalist CRS / industry systems"* kèm caveat. FuzzingBrain V1/V2, PAGENT là **preprint arXiv**.

---

## Khuyến nghị cho luận văn

**Phân tách rõ 2 loại baseline (đừng trộn):**

| Loại baseline | Dùng để | Chọn |
|---|---|---|
| **Baseline KIẾN TRÚC** (so thiết kế hệ thống, định tính) | Related Work / System Comparison | **FuzzingBrain V2 (dẫn đầu)** + **ATLANTIS** + **Buttercup** (cụm comparable) |
| **Baseline SỐ LIỆU leak** (so P/R/F1 định lượng) | Evaluation | **LAMeD** (peer-reviewed) + **MemHint** (SOTA) — xem `01-bao-cao-tong-hop.md`, `02-bang-so-sanh-baselines.md` |

**Cách diễn đạt đúng trong luận văn (đừng nói "chỉ FuzzingBrain V2"):**
> *"Analogue kiến trúc gần nhất là FuzzingBrain V2 — hệ duy nhất hiện thực hoá đầy đủ static+dynamic+multi-agent+MCP+judge trên C/C++. Một cụm hệ thống tương đương về kiến trúc là các CRS thắng giải AIxCC 2025 (ATLANTIS, Buttercup), tuy chúng không xác nhận dùng MCP và không nhắm riêng memory leak. Khác biệt cốt lõi: tất cả các hệ này xác minh bằng crash do sanitizer, còn leak-investigator nhắm lớp lỗi không-crash, hợp nhất bằng chứng static+dynamic (LSan/Valgrind) trong một judge sinh verdict + giải thích + bản vá."*

> 💡 **Mẹo định vị mạnh:** dùng **RoboDuck (Theori)** làm *trường hợp tương phản* — nó cố tình "LLM-first, không fuzzing". Đối chiếu nó để **biện minh cho lựa chọn giữ Valgrind/ASan/LSan** của bạn thay vì tin verdict thuần-LLM.

---

## Nguồn (đã verify)
- FuzzingBrain V2 — https://arxiv.org/abs/2605.21779
- ATLANTIS (Team Atlanta) — https://arxiv.org/abs/2509.14589
- Buttercup (Trail of Bits) — https://github.com/trailofbits/buttercup
- PAGENT — https://arxiv.org/abs/2604.07624
- ARTIPHISHELL (Shellphish) — https://deepwiki.com/shellphish/artiphishell
- RoboDuck (Theori) — blog AIxCC (Theori)
- FuzzingBrain V1 — https://arxiv.org/abs/2509.07225
