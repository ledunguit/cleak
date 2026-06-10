# LAMeD — Đánh giá khả năng REPRODUCE

> **Câu hỏi:** LAMeD có reproduce được không?
> **Trả lời ngắn:** ✅ **Có — nhưng "reproducible-in-principle, assembly-required"**, không phải one-command artifact và **không** đạt độ chính xác số liệu bit-exact nếu không làm thêm.
> **Verdict:** `partially-reproducible` (gần mức "mostly", nhưng hạ xuống "partial" vì component quyết định nhất — bản build Cooddy sinh ra con số headline — **không được vendored/pin version** trong artifact).

*Phương pháp: workflow 5 chiều (code / data / tools / models / artifact-badge), mỗi claim availability verify đối kháng 3 phiếu. Kết quả: **cả 5/5 chiều đều 3-0 supported**. Ngày: 2026-06-09. Đã tải & giải nén trực tiếp artifact để kiểm chứng.*

---

## TL;DR — bảng trạng thái

| Chiều | Trạng thái | Tóm tắt |
|---|---|---|
| **Code** (pipeline + prompts) | ✅ Available | Artifact chính thức trên **Zenodo** (BSD-3-Clause), có `lamed_run.py` + **prompt LLM thật** (`lamed.yaml`) + Dockerfile |
| **Data** (cJSON + 8460 hàm) | ✅ Available | Bản Zenodo **mới nhất** chứa `cJSON-annotated.csv` (152 hàm) + `memleak_benchmark.json` (8460 hàm/7 dự án) |
| **Tools** (Cooddy/CodeQL/Infer) | 🟡 Partial | Cooddy **open-source** + interface annotation có docs, NHƯNG **không pin version**; CodeQL engine proprietary (academic-free); Infer MIT nhưng thiếu hook AllocSource/FreeSink |
| **Models** (3 LLM) | ✅ Available | Cả 3 open-weight trên HuggingFace; **Qwen2.5-Coder-32B (Apache-2.0)** là sạch nhất để repro |
| **Artifact badge / repro độc lập** | ❌ Unavailable | **Không** có badge AE ở EASE 2025; **chưa ai** reproduce độc lập; deposit vẫn để tác giả "Anonymous" |

---

## 1. Code & Artifact — ✅ có, mở, BSD-3-Clause

LAMeD **không có repo GitHub/GitLab chính thức**. Thay vào đó, artifact nằm trên **Zenodo** (community `llm-4-lsr` — "Large Language Models for Large Software Repositories"):

- **Concept DOI** (luôn trỏ bản mới nhất): `10.5281/zenodo.13758867`
- **Bản mới nhất:** `10.5281/zenodo.15089703` (v6, 2025-03-23) — https://zenodo.org/records/15089703
- **License:** **BSD 3-Clause** (permissive, dùng tự do cho luận văn)
- **Tác giả:** vẫn để **"Anonymous"** (bản nộp review; lời hứa "official open release upon acceptance" **chưa** thấy thực hiện)

**Nội dung bản mới nhất (3 file, ~42 kB):**
| File | Vai trò |
|---|---|
| `lamed-pipeline.zip` (14.3 kB) | **Code chạy được + prompt**: `lamed_run.py` (Joern call-graph qua `cpgqls_client` → query LLM qua `mistralai`/`openai` → convert JSON LLM thành annotation Cooddy `AllocSource::1`/`FreeSink::1` → ghi report), `src/eval.py`, `src/utils.py`, `Dockerfile`, `entrypoint.sh`, `pre_build.sh`, `requirements.txt`, và **`lamed.yaml` chứa prompt template thật** (model mặc định `codestral-latest` qua Mistral API) |
| `cJSON-annotated.csv` (5.0 kB) | Benchmark cJSON 152 hàm (nhãn ALLOC/DEALLOC) |
| `memleak_benchmark.json` (23.0 kB) | Benchmark real-life 8460 hàm / 7 dự án (entry leak kèm commit URL) |

> 💡 **Điểm cộng lớn:** **prompt LLM được công bố** (`lamed.yaml`) — thứ khó kiếm nhất thường lại bị giấu, nhưng ở đây **có sẵn**.

**Lưu ý:** kéo thêm bản **v3** (`10.5281/zenodo.13826179`, 2024-09-22) vì nó chứa file **bổ sung KHÔNG có trong bản mới nhất**: `dataset_generator.zip` (script sinh leak tổng hợp dựa trên libsolv) + `annotation_synthetic_reports.zip` (report Cooddy theo 5 kịch bản annotation).

---

## 2. Data — ✅ có (cả hai benchmark + corpus nguồn công khai)

- **cJSON benchmark (152 hàm):** ✅ có trong `cJSON-annotated.csv`. Cần kiểm split 44 AllocSource / 11 FreeSink / 97 unlabeled khi giải nén.
- **Real-life dataset (8460 hàm / 7 dự án — curl, libsolv, libtiff, libxml2, rabbitmq-c, libssh2, cjson):** ✅ có trong `memleak_benchmark.json`. ⚠️ File công bố ghi **~35 entry leak**, trong khi paper nêu **43 target leak** → bản phát hành là **tập con**; kiểm lại field-level khi dùng.
- **Corpus nguồn DiverseVul** (RAID 2023, github.com/wagner-group/diversevul): ✅ **fully public** (qua Google Drive).

> Vì sao bước đầu đánh giá là "partial": **README của bản v3** chỉ mô tả Cooddy harness + synthetic generator + annotation reports, **không liệt kê** nhãn cJSON / ground-truth leak. Nhưng **bản mới nhất (v6)** thực tế **đã chứa** hai file benchmark cụ thể → data thực chất **available**.

---

## 3. Tools — 🟡 partial (đây là nút thắt reproduce)

| Tool | Trạng thái | Chi tiết |
|---|---|---|
| **Cooddy** (analyzer chính) | 🟡 | **Open-source** github.com/program-analysis-team/cooddy, **GPL-3.0 + linking exception**. Ship đúng **`MemoryAndResourceLeakChecker`** mà LAMeD điều khiển. Interface annotation **có docs đầy đủ** (`docs/Annotations.md`: file JSON, AllocSource kind 1–5, FreeSink kind 1–5, cú pháp offset). **NHƯNG**: Dockerfile của LAMeD **giả định binary `cooddy` đã build sẵn** (truyền qua build-arg "internal") — **không vendored, không pin commit** → **rủi ro lớn nhất về fidelity** (analyzer-version drift). Repo bảo trì tối thiểu (~5 commit, ~54 star). Quy kết "Huawei" chỉ từ proceedings ISP RAS, **không ghi trên repo**. |
| **CodeQL** | 🟡 | Query (github/codeql) open-source, nhưng **engine/CLI proprietary** ("licensed, not sold") — **miễn phí cho academic research** + phân tích OSS, **không được redistribute** binary, code đóng cần GHAS trả phí. **Không có script harness LAMeD cho CodeQL** → phải tự implement từ mô tả paper. |
| **Infer** | 🟡 | **Fully open-source, MIT** (github.com/facebook/infer). Nhưng engine Pulse **không có hook annotation per-function AllocSource/FreeSink** → khó "lái" kiểu LAMeD nhất, dù license thoáng nhất. Cũng **không có script harness LAMeD**. |

---

## 4. Models — ✅ có (cả 3 open-weight)

| Model | License | VRAM (xấp xỉ) | Ghi chú |
|---|---|---|---|
| **Qwen2.5-Coder-32B** | **Apache 2.0** ✅ | ~18–20 GB @ Q4 | **Sạch nhất để reproduce** — khuyến nghị dùng |
| **Codestral-22B-v0.1** | **Mistral Non-Production License** (research OK, không thương mại, thường gated) | ~13–14 GB @ Q4 | **Model paper dùng cho full run 8460 hàm**; có mirror cộng đồng `mistral-community/Codestral-22B-v0.1` |
| **DeepSeek-R1-Distill-Llama-70B** | MIT + nghĩa vụ Llama 3.3 | ~140 GB BF16 (2×80GB) / ~40–45 GB @ Q4 multi-GPU | **Rào cản phần cứng**; bất khả thi trên 1 GPU consumer |

⚠️ Paper **không** báo hardware/VRAM, **không** báo cấu hình inference (quantization, framework, context length, temperature/sampling) → phải tự suy ra, khó khớp số chính xác.

---

## 5. Artifact badge & reproduce độc lập — ❌ không

- **Không có badge artifact-evaluation:** EASE 2025 **không có AE track**; trang chương trình chỉ link arXiv preprint, không có badge Available/Functional/Reusable/Reproduced. ACM DL (10.1145/3756681.3756999) bị paywall (403).
- **Chưa ai reproduce/độc lập tái dùng:** paper liên quan duy nhất sau đó (MemHint, 2026) chỉ **cite ngữ cảnh**, **không** chạy lại hay tái dùng benchmark của LAMeD.
- Deposit vẫn để **"Anonymous"** — không có upstream repo có tên, được bảo trì.

---

## 6. Kế hoạch reproduce thực tế (cho luận văn)

1. **Lấy artifact:** tải **cả bản mới nhất** (`zenodo.15089703` → pipeline + 2 benchmark) **và v3** (`zenodo.13826179` → `dataset_generator.zip`, `annotation_synthetic_reports.zip`). Verify byte-count.
2. **Soi, đừng tin mù:** giải nén `lamed-pipeline.zip`, đọc `README.md`, `lamed_run.py`, `lamed.yaml` (xác nhận prompt + logic convert JSON→annotation). Giải nén 2 benchmark, kiểm split cJSON (44/11/97) và ground-truth leak.
3. **Dựng Cooddy (analyzer load-bearing):** clone & build github.com/program-analysis-team/cooddy, đọc `docs/Annotations.md`. **PIN một commit cụ thể và ghi lại** — artifact không pin, đây là rủi ro fidelity lớn nhất. Wire binary vào Dockerfile/`entrypoint.sh`.
4. **Dựng Joern:** pipeline dùng `cpgqls_client` nói chuyện với Joern server (github.com/joernio/joern). Cài, chạy server, xác nhận `lamed_run.py` kết nối được.
5. **Chọn LLM:** để repro tối đa → **Qwen2.5-Coder-32B (Apache-2.0)**; để khớp run headline → thêm **Codestral-22B**; chỉ dùng 70B nếu có multi-GPU. `lamed.yaml` mặc định gọi Mistral API → trỏ về endpoint local (vLLM/TGI) để chạy offline như paper. **Ghi lại** quantization/context/sampling.
6. **Reproduce micro-benchmark cJSON trước** (nhỏ, nhanh, có nhãn): chạy pipeline trên cJSON tại commit paper pin (`12c4bf1986`), so leak phát hiện với `cJSON-annotated.csv`, đối chiếu 5 kịch bản annotation trong v3.
7. **Scale lên real-life:** chạy 7 dự án, dùng `memleak_benchmark.json` làm ground-truth, tính P/R so với paper. **Kỳ vọng có sai lệch** (analyzer drift + LLM nondeterminism + inference config ẩn) → báo cáo delta như threat-to-validity, **đừng** kỳ vọng khớp tuyệt đối.
8. **(Tùy chọn) so chéo analyzer:** CodeQL/Infer phải **tự implement harness** (artifact không có).

> **Setup gọn nhất, dễ bảo vệ nhất cho luận văn:** `LAMeD-prompt + Cooddy + Qwen2.5-Coder-32B` (tất cả open/permissive), chạy trên **chính corpus của bạn** (`demo/memory_leak_corpus`) **và** `memleak_benchmark.json` (để so sánh). Document commit Cooddy, cấu hình LLM/inference, và mọi sai lệch.

---

## 7. Vật cản chính (obstacles)

1. **Cooddy không vendored/pin version** — analyzer sinh số headline không self-contained, không có commit ghi lại → drift không sửa được từ artifact.
2. **Artifact vẫn anonymized** — không có repo upstream có tên/được bảo trì; "official release upon acceptance" chưa thấy.
3. **Không badge AE, không repro độc lập** — không có xác nhận ngoài rằng pipeline tái tạo đúng số báo cáo.
4. **Thiếu chi tiết inference** — không hardware/VRAM, không quantization/temperature → khó khớp số tuyệt đối.
5. **Codestral gated + license non-production**; **DeepSeek-70B tường phần cứng**.
6. **CodeQL/Infer thiếu script harness** — phải implement lại từ prose.
7. **Gánh nặng lắp ráp** — Joern + Cooddy build + LLM serving + (synthetic) dataset_generator đều phải tự wire; Dockerfile là điểm khởi đầu, không turnkey.

---

## 8. Kết luận cho luận văn

LAMeD **reproduce được về bản chất (method)** và **là một trong số ít baseline có artifact mở thực sự tốt**: code + **prompt thật** + **cả 2 benchmark** dưới BSD-3-Clause, 3 LLM open-weight, analyzer chính open-source có docs annotation. Đây là lý do nó vẫn là **baseline peer-reviewed mạnh nhất** (xem `lamed.md`).

**Nhưng** đây là baseline **"assembly-required"**: hãy coi nó là **reproducible-in-principle** — dùng được & cite được, nhưng **bạn phải tự pin mọi version** (đặc biệt Cooddy) vì tác giả không làm, và **báo cáo sai lệch số liệu như threat-to-validity** thay vì kỳ vọng khớp bit-exact.

## Nguồn (đã verify)
- Artifact mới nhất: https://zenodo.org/records/15089703 · API: https://zenodo.org/api/records/15089703
- Artifact v3 (bổ sung): https://zenodo.org/records/13826179
- Community: https://zenodo.org/communities/llm-4-lsr
- Paper (data-availability statement, Section 8): https://arxiv.org/html/2505.02376v1
- Cooddy: https://github.com/program-analysis-team/cooddy (+ `docs/Annotations.md`)
- DiverseVul: https://github.com/wagner-group/diversevul
- CodeQL CLI license: https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md · Infer: https://github.com/facebook/infer
