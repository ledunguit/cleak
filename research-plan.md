# Kế hoạch nghiên cứu: Trình quét rò rỉ bộ nhớ C/C++ do LLM điều phối

> Cập nhật: 2026-06-28
> Trạng thái: **Hệ thống đã xây xong (TUI-only)** → giai đoạn **đánh giá luận văn + củng cố**
>
> Tài liệu này là bản tổng hợp **đứng-một-mình** (đọc không cần mở file khác vẫn hiểu). Bản kế
> hoạch web-era (2026-05, control-plane + React UI + gRPC) đã **bị thay thế** — kiến trúc đó đã
> gỡ khỏi `master`, còn bảo tồn ở git history + nhánh `web-implementation`. Tài liệu nguồn chi
> tiết: xem mục [Phụ lục](#phụ-lục--tài-liệu-nguồn).

---

## §1. Bối cảnh & bài toán

**Rò rỉ bộ nhớ (CWE-401) trong C/C++ là khuyết tật *không gây crash*:** chương trình vẫn chạy
nhưng hao mòn bộ nhớ dần — khó lộ qua kiểm thử thông thường, không có "đầu vào tái hiện crash"
như use-after-free hay double-free.

- **Công cụ tĩnh** (Clang Static Analyzer, Infer, CodeQL) sinh ứng viên nhưng **tỉ lệ dương tính
  giả (FP) cao**.
- **Công cụ động** (Valgrind, ASan, LSan) cho bằng chứng lúc chạy nhưng **chỉ thấy đường đã thực
  thi** (cần đầu vào kích hoạt).
- **Cả hai chỉ đưa cảnh báo** — không giải thích nguyên nhân, không đề xuất sửa.

**Ý tưởng luận văn:** dùng một **LLM điều phối** vòng lặp điều tra — chọn công cụ phân tích nào
chạy tiếp, **hợp nhất bằng chứng tĩnh + động**, rồi một **tầng phán quyết (judge)** sinh
**verdict + giải thích root-cause + diff sửa**. Vòng lặp 3 pha: **discovery → investigation loop
→ judging/reporting**.

**Khoảng trống nghiên cứu (khảo sát 2025–2026):** *chưa có* hệ nào kết hợp **cả tĩnh lẫn động,
chuyên cho memory-LEAK** trong C/C++. Các hệ agentic gần nhất (FuzzingBrain V2, ATLANTIS,
Buttercup) đều xác minh **bằng crash**, không xử lý rò rỉ non-crash. Đây là vị trí định vị của
luận văn.

---

## §2. Kiến trúc hiện tại

`master` là **TUI-only**. **MCP/HTTP là transport duy nhất** — server gRPC, thư mục `proto/`,
`@nestjs/microservices`, submodule LeakGuard (TensorFlow) đều đã **gỡ bỏ**.

```
                         ┌───────────────────────────────────────────┐
                         │   leak-inspector-tui  (@cleak/cli, host)   │
                         │   ORCHESTRATOR — Ink CLI/TUI               │
                         │   native tool-calling qua agent-core       │
                         │   ghi report → results/<scanId>/           │
                         └───────────────┬───────────────────────────┘
                                         │ MCP / HTTP (Streamable)
                   ┌─────────────────────┴─────────────────────┐
                   ▼                                           ▼
        ┌────────────────────────┐                ┌────────────────────────┐
        │  static-analyzer :50061│                │ dynamic-analyzer :50062│
        │  NestJS + Tree-sitter  │                │  NestJS                │
        │  11 MCP tool:          │                │  9 MCP tool:           │
        │  index/candidate/AST/  │                │  buildTarget/          │
        │  callGraph/funcSummary/│                │  Valgrind Memcheck/    │
        │  pathConstraints (Z3)/ │                │  AddressSanitizer/     │
        │  interprocFlow/        │                │  LeakSanitizer/        │
        │  ownership/            │                │  runBinary/compare/    │
        │  Clang scan-build      │                │  listRuns              │
        └────────────────────────┘                └────────────────────────┘
                   ▲                                           ▲
                   └──────── LLM gateway :20128 (mimo/mimo-v2.5-pro,
                              hoặc OpenAI/Anthropic) ─ chỉ tầng POLICY ─┘
```

| Thành phần | Công nghệ | Cổng | Vai trò |
|---|---|---|---|
| **leak-inspector-tui** (`@cleak/cli`) | TS + Ink (Bun) | — (host) | **Orchestrator** — scanner độc lập, MCP client, native tool-calling |
| **static-analyzer** | NestJS + Tree-sitter (C + C++) | **50061** (MCP/HTTP) | 11 tool: index, candidate scan, AST, call graph, function summary, path constraints (Z3), interprocedural flow, ownership, **Clang `scan-build`** (tự chứa) |
| **dynamic-analyzer** | NestJS + Valgrind/ASan/LSan | **50062** (MCP/HTTP) | 9 tool: build target, Memcheck, ASan, LSan, run binary, compare, list — **Linux/Docker-only** |
| **agent-core** (`@cleak/agent-core`) | thư viện TS | — | Vòng lặp agentic: tool abstraction, MCP client, `callModel` đa provider (streaming, idle-timeout, nén ngữ cảnh) |
| **@cleak/common** | thư viện TS | — | Types + Zod schema, heuristic judge, **consensus judge**, leak analysis, render report |

### 2.1 Orchestrator — bộ não của luận văn

Orchestrator **không chỉ "gọi hai analyzer"** — nó **làm chủ toàn bộ luồng quyết định**: khám
phá gì, gọi tool nào tiếp theo, khi nào chuyển sang động, phán quyết ra sao. Đây là nơi đặt
**đóng góp cốt lõi** của luận văn — **LLM cầm lái POLICY** (mở, theo-dự-án) còn **Engine bảo đảm
tất định**. Bung rõ bên trong (mũi tên ▼ = luồng pha; nhãn bên phải = pha đó do **LLM** hay
**ENGINE** đảm nhiệm):

```
┌─ leak-inspector-tui · ORCHESTRATOR (bộ não) — chạy trên agent-core ────────────

   repo C/C++
      │
      ▼
   ① PROFILING / STRATEGY       LLM · POLICY    allocatorProfiler · strategist
      │                                         grep / SMT-verify → cache .cleak/
      │                         (eval: ĐÓNG BĂNG — manifest cấp allocator → 0 LLM)
      ▼
   ② DISCOVERY                  ENGINE · tất định
      │                         walkCFiles → candidateScan → LeakBundle[]
      ▼
   ③ STATIC-ENRICH  (opt-in)    ENGINE · tất định · Z3
      │                         functionSummary · pathConstraints → staticEvidence
      ▼
   ④ INVESTIGATION              LLM · AGENTIC  (chỉ llm_assisted)
      │    ┌ agent-core loop:  model ⇄ tool-call ⇄ result ⇄ …  (lặp)
      │    │   • thu bằng chứng tĩnh  ········· MCP ▶ static-analyzer  :50061
      │    │   • worker động buildTarget→lsanRun  MCP ▶ dynamic-analyzer :50062
      │    └   (recipe động TẤT ĐỊNH, không LLM)  → dynamicCoverage
      ▼
   ⑤ JUDGING  (hybrid)          ENGINE + LLM (chỉ ca borderline)
      │    heuristic path-sensitive cho MỌI bundle
      │    └▶ borderline / static↔dynamic DISAGREE → LLM judge
      │         └▶ CONSENSUS k mẫu → verdict + giải thích + diff sửa
      ▼
   ⑥ REPORTING                  ENGINE · tất định
           snapshot.json · report.{json,md,html} · events.jsonl · metrics.json
└──────────────────────────────────────────────────────────────────────────────
```

**Chú giải:** `LLM·POLICY` = quyết định theo-dự-án, **đóng băng khi eval** ⇒ 0 LLM trên đường
đo · `LLM·AGENTIC` = vòng native tool-calling, chỉ ở `llm_assisted` · `ENGINE` = cơ chế **tất
định** (tree-sitter parse · CFG · Z3 SAT · ghép alloc↔free · scoring · consensus). Hai cổng MCP
ra ngoài (① §2) là điểm DUY NHẤT orchestrator chạm tới analyzer.

**Sáu pha của pipeline HYBRID (chi tiết):**

1. **Profiling / Strategy (LLM, tuỳ chọn)** — `allocatorProfiler` (khám phá allocator + ownership
   notes theo dự án) + `strategist` (quyết `runDynamic`/`judge`/`staticDepth`). Cache ở `<repo>/.cleak/`.
   **Eval ĐÓNG BĂNG tầng này** (manifest cấp allocator) ⇒ 0 LLM trên đường eval.
2. **Discovery (tất định)** — `walkCFiles` (loại test/fuzz/vendor) → `candidateScan` (alloc sites:
   libc + factory theo allocator + C++ `new` + parameter-ownership) → `CandidateManager` → `LeakBundle[]`.
3. **Static-enrichment (tất định, `STATIC_ENRICH=on`)** — `functionSummary` + `pathConstraints` (Z3
   feasibility) → `bundle.staticEvidence` (alloc↔free pairs, feasible-leak-paths).
4. **Investigation (agentic, CHỈ `llm_assisted`)** — sub-agent native tool-calling thu bằng chứng
   qua MCP; worker động chạy `buildTarget → lsanRun` (recipe **tất định**, không LLM).
5. **Judging (hybrid)** — heuristic cho MỌI bundle (path-sensitive, không LLM) + LLM judge cho ca
   **BORDERLINE** (escalate khi static↔dynamic mâu thuẫn) + **consensus** k mẫu (tuỳ chọn).
6. **Reporting** — `snapshot.json`, `report.{json,md,html}`, `events.jsonl`, `metrics.json` → `results/<scanId>/`.

> **Nguyên tắc cốt lõi:** **LLM = POLICY** (quyết định theo-dự-án: allocator, chiến lược, ownership
> notes) → hồ sơ có cấu trúc → grep/SMT-verify → cache → **đóng băng cho eval** → nạp cho **Engine
> = MECHANISM** (tree-sitter parse, CFG, ghép alloc↔free, Z3 SAT, scoring, consensus). Engine
> **không phụ thuộc LLM trên đường eval** ⇒ giữ Tier-1 tất định.

**Cấu hình:** qua biến env / file `.env`, hoặc — cho bản cài global — `cleak config`
(`~/.config/cleak/config.json`). Ưu tiên: CLI flag > env > config file > default.

---

## §3. Đóng góp (C1–C4)

| | Đóng góp | Nội dung | Bằng chứng |
|---|---|---|---|
| **C1** | **Consensus judge** | Bỏ phiếu k mẫu LLM độc lập + hợp nhất bằng chứng static↔dynamic (heuristic veto FP độ-tin-thấp). Giảm tỉ lệ lật verdict **~2–4×**. | `packages/common/src/analysis/consensus-judge.ts`; `llmJudge.ts shouldEscalate`; `scripts/consensus-ablation.sh` |
| **C2** | **Tái lập hai tầng** | Tier-1 `no_llm` **bitwise-deterministic** (gate `determinism-gate.sh` từ chối self-compare + run lỗi); Tier-2 `llm_assisted` báo **biến thiên tường minh** (mean ± CI, theo dõi độ ổn định verdict). | `scripts/{determinism-gate.sh, assert-determinism.ts, verdict-stability.ts}` |
| **C3** | **Động tất định** | Recipe build+run **ghim cứng** (không LLM trong thực thi) → coverage tất định (`exercised_clean / exercised_leak / not_exercised / dynamic_off`). Tách biến-thiên-động khỏi biến-thiên-judge. | `apps/leak-inspector-tui/src/domain/dynamicEvidence.ts`: `runDeterministicDynamic`, `withDynamicEvidenceCapture` |
| **C4** | **Làm giàu bằng chứng** | Mỗi bundle có: ownership, cặp alloc↔free (paired/conditional/unpaired), feasible-leak-path (narrative + reachability), phương pháp tương quan (LINKED vs file-only). Cho judge + report suy luận theo-bundle. | cấu trúc `snapshot.json`; verdict card TUI; report md/html |

---

## §4. Kết quả hiện tại

### Juliet CWE-401 (n=30, analyzer MCP qua Docker)

| Hệ | P | R | F1 |
|---|---|---|---|
| **leak-investigator** (`no_llm`, heuristic) | **0.806** | **0.906** | **0.853** |
| Clang Static Analyzer (cùng corpus, cùng `scoreCase`) | ~0.69 | ~0.84 | ~0.76 |

### Ablation 2×2 (LLM-orchestration × dynamic-evidence)

| | static (`--dynamic off`) | + dynamic (`selective/aggressive`) |
|---|---|---|
| **no_llm** | TP29 FP7 FN3 · P0.806 R0.906 F1 0.853 | TP29–30 FP7 FN2–3 · R0.906–**0.938** |
| **llm_assisted** | TP29 FP7 FN3 · P0.806 R0.906 | TP29–30 FP7 FN2–3 · R0.906–0.938 |

### Consensus giảm lật verdict (2 đợt, 2 run/nhánh, 30 ca)

| Judge | Đợt | Ổn định ca | **Tỉ lệ lật** | Đồng thuận modal |
|---|---|---|---|---|
| single-LLM (`n=1`) | A | 73.3% | **26.7%** (8/30) | 86.7% |
| single-LLM (`n=1`) | B | 86.7% | **13.3%** (4/30) | 93.3% |
| consensus (`n=3`) | A | **93.3%** | **6.7%** (2/30) | **96.7%** |
| consensus (`n=3`) | B | **93.3%** | **6.7%** (2/30) | **96.7%** |

→ Bỏ phiếu k=3 cắt tỉ lệ lật **~2–4×**; nhánh consensus **lặp lại y hệt** qua 2 đợt (tính chất ổn
định, không phải số may).

### Tái lập & ý nghĩa thống kê

- **Tier-1 (`no_llm`):** hai run thư mục tách biệt → chấm điểm **TP29 FP7 FN3 TN38 y hệt** (byte-identical).
- **McNemar (đợt B, 77 site, single vs consensus):** χ²=0.57, **p=0.45** — *có hướng* nghiêng
  consensus nhưng **chưa significant ở n=30**; cần corpus lớn hơn cho thắng-ghép-cặp.

### Dự án thực (cjson LAMeD, 6 leak — chạy live cả 4 cấu hình)

- **Recall = 0% ở MỌI cấu hình baseline.** Không phải lỗi một-nguyên-nhân mà là thách thức nhiều mặt:
  - **Tầng discovery:** leak ở **factory function** (`cJSON_Duplicate`, `cJSON_CreateObject`) — tên
    không chứa token `malloc/alloc` → cần allocator-aware discovery (đã thêm).
  - **Tầng judging:** leak là **path-sensitive + interprocedural ownership** (object thêm vào struct
    cha nhưng rò trên một đường error/early-return).
  - **Taxonomy 6 leak** (đọc trực tiếp từ 6 fix-commit): 2 **deallocator-semantics** (`cJSON_Delete`
    bỏ qua buffer gắn cờ const), 2 **missing-free trên một đường** (`merge_patch`…), 1 control-flow,
    1 file-level.
- **Path-sensitive recall (F1–F4, opt-in):** Z3 path-feasibility bắt được **ca thật đầu tiên**
  (`merge_patch`, 1/6) khi bật `STATIC_ENRICH=on`; nhưng heuristic CFG **over-report trên Juliet
  (FP 7→44)** nếu không có Z3 ⇒ **chỉ để opt-in**, baseline Juliet giữ nguyên 0.806/0.906/0.853.

### Phát hiện trung thực (đưa vào Threats, §8)

- Trên **Juliet *dễ*, heuristic baseline là mạnh nhất** (F1 0.853); LLM + dynamic *thêm nhiễu* ở đây.
- **LLM judge KHÔNG lay chuyển Juliet** (`no_llm` ≡ `llm_assisted`, đều TP29 FP7 FN3) — corpus dễ ⇒
  bundle non-borderline ⇒ heuristic chốt. Giá trị LLM/dynamic kỳ vọng ở corpus **KHÓ / dự án thực**.

---

## §5. Định vị & baseline

Chọn theo **3 trục bù nhau** (không baseline nào khớp cả static+dynamic+agentic+judge cho leak):

- **Trục A — leak C/C++ trực tiếp:** **LAMeD** (EASE 2025, **peer-reviewed duy nhất**; LLM sinh
  annotation cho analyzer cổ điển; static-only; cJSON P0.933/R0.583 — minh hoạ đánh đổi recall↑/FP↑)
  · **MemHint** (arXiv 2026, preprint; neuro-symbolic + Z3 + LLM-confirm; static-only; 52–54 leak/7 dự án).
- **Trục B — kiến trúc (agentic / judge / static+dynamic / MCP):** **FuzzingBrain V2** (arXiv 2026;
  multi-agent MCP; gần nhất nhưng xác minh **bằng crash**) · **RepoAudit** (ICML'25 poster; agent +
  SAT validator; đa-defect) · **ATLANTIS** (vô địch AIxCC'25) · **Buttercup** (Trail of Bits, AGPL-3.0)
  — đều xác minh **bằng crash**.
- **Trục C — formal / dataset:** **POM** (CMU/SEI; LLM gán nhãn pointer + SAT, hướng prevention) ·
  **SecVulEval** (dataset 25.4K hàm, preprint).

**Định vị:** baseline leak trực tiếp đều **static-only** → ta thêm **dynamic** + **judge hợp nhất**;
analogue kiến trúc xác minh **bằng crash** → ta chuyển sang lớp **non-crash leak**. **Caveat:**
baseline mỏng — chỉ LAMeD đã phản biện đầy đủ; còn lại preprint/tech-report/poster. Chi tiết + log
kiểm chứng + **claim bị bác bỏ** (KHÔNG trích): `docs/RELATED-WORK.md` + `researchs/`.

---

## §6. Việc còn lại — roadmap tới bảo vệ

| # | Ưu tiên | Hạng mục | Vì sao |
|---|---|---|---|
| **R1** | **P0** | Mở rộng **corpus dự án thực** + **auto-sinh driver** | cjson không có `build_command`/driver → dynamic **skip**; corpus thật mới 4 ca (2 cặp cjson). Gap lớn nhất cho recall thực tế. |
| **R2** | P1 | Siết **tương quan dynamic↔candidate** | Correlation thô → +FP trên Juliet; escalate consensus khi static↔dynamic **DISAGREE** (`shouldEscalate` đã có, cần đo lại multi-seed). |
| **R3** | P1 | **Ý nghĩa thống kê** | Multi-seed `llm_assisted` + McNemar/bootstrap trên corpus lớn hơn (n=30 → p=0.45 chưa đủ; tooling đã có). |
| **R4** | P2 | **Engine-debt** còn lại (tất định) | Full CFG-dataflow reachability; goto/longjmp liên thủ tục; field/alias dataflow; deallocator-semantics (const-skip); dùng Z3 để **bỏ opt-in** của F1–F4 (hết over-report Juliet). |
| **R5** | P2 | LLM-generalization **Move 2** | `ownershipNotes` (đang dormant) → ownership profile có cấu trúc (returnOwnership/freeMode/paramOwnedTypes…), thay heuristic `type.includes('*')`. |
| **R6** | P2 | Mở rộng **baseline cài-được** | Chạy Infer/CodeQL/Cooddy cùng corpus + cùng `scoreCase` (hiện mới có adapter clang). |
| **R7** | P3 | **Viết luận văn** + gói tái lập | Chương kết quả + định vị; snapshot + frozen profiles cho reproducibility. |

> Trạng thái nền (đã xong, để khỏi lặp lại): C-parser CFG path-sensitive; C++ (E1), switch-guard
> (E2), dead-code reachability (E3); Z3 feasibility (F1–F4); allocator-aware discovery; allocator
> profiler / strategist / judge-tuner (LLM POLICY, **tắt trong eval**); consensus + escalation;
> two-tier reproducibility; deterministic dynamic; evidence enrichment; eval site-based +
> McNemar/bootstrap + baseline adapter clang.

---

## §7. Tái lập (reproduction)

```bash
# 1) Dựng 2 analyzer (MCP) — static :50061, dynamic :50062
docker compose up --build

# 2) Eval tất định (no_llm), 30 ca Juliet, có tầng động
EVAL_STATIC_URL=http://127.0.0.1:50061/mcp EVAL_DYNAMIC_URL=http://127.0.0.1:50062/mcp \
  bun scripts/evaluate-corpus.ts no_llm --corpus demo/juliet_cwe401 --dynamic selective

# 3) llm_assisted nhiều seed → báo biến thiên (Tier-2)
bun scripts/evaluate-corpus.ts llm_assisted --corpus demo/juliet_cwe401 --runs 5

# 4) Cổng tất định Tier-1 + ablation consensus + so baseline
scripts/determinism-gate.sh
scripts/consensus-ablation.sh
bun scripts/compare-baselines.ts
```

> **Gotcha:** `evaluate-corpus.ts` mặc định URL 50071/50072 (dev-server); **docker stack expose
> 50061/50062** — luôn set `EVAL_STATIC_URL`/`EVAL_DYNAMIC_URL` (các script gate/ablation đã mặc
> định đúng). Chi tiết: `docs/OPERATIONS.md` · `docs/EVALUATION.md`.

---

## §8. Threats to validity

- **Juliet là corpus *dễ*:** heuristic + dynamic có thể *tăng* FP; F1 cao chưa chứng minh được giá
  trị LLM trên ca khó.
- **Biến thiên single-LLM cao:** mỗi run lật verdict borderline (temp=0 vẫn lật ở gateway) → luôn
  **multi-seed + McNemar/bootstrap** trước khi quy kết hiệu ứng cho thay đổi code.
- **Baseline mỏng:** chỉ LAMeD (EASE 2025) đã phản biện đầy đủ; còn lại preprint/tech-report/poster
  — kiểm lại venue/số liệu trước bản nộp.
- **Corpus dự án thực nhỏ:** 4 ca (2 cặp cjson) → kết luận trên dự án thực cần mở rộng (R1).
- **LLM judge chưa lay chuyển Juliet:** kỳ vọng giá trị ở corpus khó — phải chứng minh bằng R1+R3.

---

## Phụ lục — tài liệu nguồn

Bản tổng hợp này rút từ các tài liệu canonical (nguồn sự thật, cập nhật hơn nếu lệch):

- [docs/THESIS.md](docs/THESIS.md) — tổng quan đọc-trước
- [docs/GOAL.md](docs/GOAL.md) — mục tiêu & tiêu chí thành công
- [docs/CONTRIBUTION.md](docs/CONTRIBUTION.md) — C1–C4 + threats chi tiết
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — thành phần, cổng, pipeline
- [docs/EVALUATION.md](docs/EVALUATION.md) — phương pháp + số liệu + two-tier
- [docs/RELATED-WORK.md](docs/RELATED-WORK.md) — baseline 3 trục + kiểm chứng
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — vận hành & tái lập

> **Ghi chú lịch sử:** bản kế hoạch gốc (2026-05) mô tả đường web (control-plane NestJS + React UI
> + gRPC, analyzer :50051/:50052, LeakGuard TensorFlow). Đường đó đã gỡ khỏi `master` (TUI-only),
> bảo tồn ở nhánh `web-implementation`.
