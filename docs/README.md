# Tài liệu — leak-investigator

Bộ tài liệu cho luận văn **"LLM điều phối điều tra rò rỉ bộ nhớ cho C/C++"**.

> **Bắt đầu ở [THESIS.md](THESIS.md)** — bản tổng quan đọc-trước (bài toán → hệ thống →
> đóng góp → kết quả → định vị → bản đồ tài liệu).

## Mục lục

### Học thuật / luận văn (tiếng Việt)
| Tài liệu | Nội dung |
|---|---|
| [THESIS.md](THESIS.md) | Tổng quan đọc-trước, dẫn xuống mọi tài liệu khác |
| [CONTRIBUTION.md](CONTRIBUTION.md) | Đóng góp/tính học thuật chi tiết + kết quả + bàn luận trung thực |
| [RELATED-WORK.md](RELATED-WORK.md) | Baseline & related work — các paper so sánh (MemHint, LAMeD, FuzzingBrain V2, RepoAudit, POM, SecVulEval, ATLANTIS, Buttercup) |
| [BASELINE-COMPARISON.md](BASELINE-COMPARISON.md) | Runbook chạy so sánh với baseline (clang-analyzer/infer) trên cùng corpus + scorer |
| [OPERATIONS.md](OPERATIONS.md) | Vận hành & tái lập kết quả end-to-end (stack, quét, eval, gate, ablation) |
| [GLOSSARY.md](GLOSSARY.md) | Thuật ngữ |

### Kỹ thuật (tiếng Anh, giữ nguyên)
| Tài liệu | Nội dung |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Thành phần, giao thức (gRPC/MCP/SSE), hai pipeline điều phối, data model |
| [sequence-diagrams.md](sequence-diagrams.md) | Sơ đồ tuần tự runtime (web path + TUI path) |
| [PROMPTS.md](PROMPTS.md) | Danh mục mọi prompt LLM (anchored tới file:line) |
| [EVALUATION.md](EVALUATION.md) | Phương pháp đánh giá, scoring, two-tier determinism (§7), baseline protocol (§6) |
| [DATASETS.md](DATASETS.md) | Lấy/dựng corpus (Juliet CWE-401, real_projects) |
| [SECURITY.md](SECURITY.md) | Mô hình tin cậy & kiểm soát khi chạy mã không tin cậy |
| [GOAL.md](GOAL.md) | Mục tiêu & tiêu chí thành công |

### Nghiên cứu nguồn
| Thư mục | Nội dung |
|---|---|
| [`../researchs/`](../researchs/) | Khảo sát baseline đầy đủ (6 báo cáo tổng hợp + phiếu từng paper), kèm log kiểm chứng/claim bị bác bỏ. RELATED-WORK.md distill từ đây. |

## Thứ tự đọc đề xuất cho hội đồng
1. [THESIS.md](THESIS.md) → 2. [CONTRIBUTION.md](CONTRIBUTION.md) → 3. [RELATED-WORK.md](RELATED-WORK.md)
→ 4. [EVALUATION.md](EVALUATION.md) → 5. [BASELINE-COMPARISON.md](BASELINE-COMPARISON.md)
→ 6. [OPERATIONS.md](OPERATIONS.md) → 7. [ARCHITECTURE.md](ARCHITECTURE.md).
