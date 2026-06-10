# FuzzingBrain V2 — Multi-Agent LLM System (MCP + Static + Dynamic)

> ⭐⭐⭐⭐ **Analogue kiến trúc gần nhất** với leak-investigator (static + dynamic + MCP + multi-agent). Nhưng memory leak chỉ là **phụ**.

## Định danh
- **Tiêu đề:** *FuzzingBrain V2: A Multi-Agent LLM System for Automated Vulnerability Discovery and Reproduction*
- **Tác giả:** Ze Sheng, Zhicheng Chen, Qingxiao Xu, Kewen Zhu, Jeff Huang (**Texas A&M University**)
- **Venue / Năm:** arXiv (2026) — **tiền ấn phẩm, chưa peer-review**
- **arXiv:** 2605.21779 (HTML v1)

## Kỹ thuật
**Multi-agent LLM system** — *"mọi agent nội bộ tuân theo MCP protocol"* — kết hợp **công cụ static + dynamic dựa trên MCP** với context engineering:
- **Static:** **Fuzz Introspector** — call graph / reachability / coverage.
- **Dynamic:** **libFuzzer** + **ASan / MSan / UBSan**.
- **Tiêu chí vuln (verify bằng sanitizer):** *"Một vị trí v là vulnerable iff tồn tại input liên tục gây crash do sanitizer phát hiện tại v."*

→ **Trùng khít** mô hình **Static MCP + Dynamic (sanitizer) + multi-agent orchestration** của leak-investigator. Đây là baseline **kiến trúc** sát nhất.

## LLM dùng
- **3 tầng:** Claude **Opus 4.5** / **Sonnet 4.5** / **Haiku 4.5**.

## Dataset & Metrics (đã verify 3-0)
- **Dataset:** phần **C/C++** của **AIxCC 2025 Final** — 40 vuln / 12 dự án.
- **Phát hiện 90% (36/40)**.
- **41 zero-day** trong 19 dự án OSS.

## Phạm vi defect
- **C/C++:** ✅ memory-safety — **UAF, double-free, buffer overflow, null deref** (lỗi gây crash, xác nhận bằng sanitizer).
- **Memory leak:** 🔶 **chỉ incidental** — **5 trường hợp** (Fig 11), **KHÔNG** phải trọng tâm.

## Vai trò làm baseline cho `leak-investigator`
- **Baseline kiến trúc / system-level:** đối chiếu thiết kế **static + dynamic + MCP + multi-agent**; đối chiếu **phương pháp eval-bằng-sanitizer** (tương tự ASan/LSan của leak-investigator).
- **KHÔNG** dùng làm baseline **số liệu leak-only** (leak không phải trọng tâm).
- **Định vị khác biệt:** FuzzingBrain V2 nhắm lỗi **gây crash**; leak-investigator chuyên **leak** (lỗi *không* gây crash, cần Valgrind/LSan để lộ) → bổ khuyết nhau, củng cố research gap.

## ⚠️ Lưu ý
- **Chưa peer-review** (preprint 2026).
- **ĐÃ BỊ BÁC BỎ:** **KHÔNG** trích framework **"Argus"** (arXiv 2604.06633) như baseline (claim fail 0-3 / 1-2).

## Nguồn
- https://arxiv.org/html/2605.21779v1
