# dynamic-analyzer

Dịch vụ **phân tích động C/C++** cho luận văn — NestJS, phục vụ **MCP/HTTP trên cổng
50062**. `leak-inspector-tui` điều phối qua MCP; **MCP/HTTP là transport duy nhất** (gRPC +
`proto/` đã gỡ trên `master`).

Nhiệm vụ: **build** target của repo bị quét với cờ instrument, rồi **chạy sanitizer**
(Valgrind Memcheck / AddressSanitizer / LeakSanitizer) để thu **bằng chứng rò rỉ lúc chạy**,
chuẩn hoá findings (bytes/blocks, kind `definitely_lost`/`indirectly_lost`, stack frame
người dùng) cho orchestrator đối chiếu với bằng chứng tĩnh.

> ⚠️ **Linux/Docker-only.** Valgrind/ASan/LSan không chạy natively trên macOS — luôn dùng
> Docker. Dịch vụ này **biên dịch và chạy mã không tin cậy**; xem mô hình tin cậy + các
> kiểm soát (ulimit confinement, build cô lập mạng) ở [docs/SECURITY.md](../../docs/SECURITY.md).

## Kiến trúc nội bộ

```
src/
  main.ts                         nạp apps/dynamic-analyzer/.env (host) → dựng DI context → serveMcp()
  mcp/dynamic-mcp-server.ts       đăng ký 9 MCP tool, delegate sang service
  services/
    build-target.service.ts       build trong Docker (--network none, --memory/--pids giới hạn)
    valgrind.service.ts           Valgrind Memcheck + chuẩn hoá report
    asan.service.ts               chạy binary dưới AddressSanitizer
    lsan.service.ts               chạy binary dưới LeakSanitizer
    binary-runner.service.ts      chạy binary KHÔNG instrument
    compare.service.ts            so sánh 2 lần chạy Valgrind
    run-manager.service.ts        lưu/liệt kê artifact theo runId
    result-parser.service.ts      parse output LSan/ASan → finding (bytes/blocks/kind/frames)
    safe-exec.ts                  confinement ulimit (CPU/AS/fsize/proc), no-shell argv
    compile-commands.service.ts   bắt compile_commands.json qua `bear` → flags -I/-D/-std thật của project
    harness-build.service.ts      biên dịch+link harness TARGETED (Stage B2) bằng flags thật đó
    libfuzzer-run.service.ts      chạy harness (entryStyle=fuzzer) trong ngân sách thời gian ngắn
```

**Stage B2 — targeted harness (opt-in, `workflow.targetedHarness.enabled`):** thay vì build
+ chạy mù cả binary (recipe mặc định), orchestrator có thể yêu cầu build **một harness nhỏ**
chỉ gọi đúng hàm/đoạn nghi vấn. `CompileCommandsService` chạy `bear -- sh -c '<buildCommand>'`
(qua `runConfined`, KHÔNG dùng docker-in-docker — container này không có `docker.sock`) để lấy
đúng flags compiler thật của project cho từng file, rồi `HarnessBuildService` biên dịch harness
+ (các) file cần thiết với đúng flags đó và link lại. `buildHarness` với `entryStyle=fuzzer`
biên dịch CÙNG harness source với `-fsanitize=fuzzer,address -DHARNESS_FUZZ` để `libfuzzerRun` dò input
trong một ngân sách thời gian ngắn khi lần chạy đơn (single-shot) đầu tiên "sạch" — harness PHẢI viết
theo khuôn 2 entry-point (`run_case()` dùng chung, chọn `main()` hay `LLVMFuzzerTestOneInput` qua
`#ifdef HARNESS_FUZZ`), nếu không sẽ đụng `main()` của chính libFuzzer khi link. Mỗi lần `buildHarness`
để lại một thư mục run (`.o` + binary) dưới `RUNS_DIR` — giữ tối đa `DYNAMIC_HARNESS_MAX_RUN_DIRS`
(mặc định 50) thư mục `harness_*` gần nhất, cũ hơn tự xoá. Xem
[docs/SECURITY.md](../../docs/SECURITY.md) mục "Targeted harness synthesis" cho mô hình tin cậy.

**Confinement khi chạy binary** (`safe-exec.ts`): bọc `ulimit` (CPU time, address-space,
file size, process count), argv mảng (không shell). Các lần chạy **sanitizer được miễn trần
`-v`** (`unlimitedAddressSpace`) vì ASan/LSan đặt chỗ ~20 TB shadow ảo — trần address-space
sẽ giết chúng; RSS vật lý vẫn bị container giới hạn. Container có sẵn `llvm-symbolizer`
(`ASAN_SYMBOLIZER_PATH`) để frame có `file:line`.

## MCP tool (11) — I/O

| Tool | Input | Trả về |
|---|---|---|
| `buildTarget` | `projectPath`, `buildCommand`, `timeoutSec?` | build với cờ sanitizer → đường dẫn binary |
| `valgrindMemcheck` | `binaryPath`, `args?`, `runId?`, `timeoutSec?` | chạy Memcheck → findings rò rỉ |
| `valgrindGetReport` | `runId` | report Valgrind đã chuẩn hoá |
| `valgrindListFindings` | `runId`, `severity?`, `functionName?` | lọc findings Valgrind |
| `valgrindCompareRuns` | `runIdA`, `runIdB` | so sánh 2 lần chạy |
| `asanRun` | `binaryPath`, `args?`, `timeoutSec?` | chạy dưới AddressSanitizer |
| `lsanRun` | `binaryPath`, `args?`, `timeoutSec?` | chạy dưới LeakSanitizer → leak `definitely/indirectly_lost` |
| `runBinary` | `binaryPath`, `args?`, `timeoutSec?` | chạy binary không instrument |
| `listRuns` | `tool?`, `limit?` | liệt kê các run đã lưu |
| `buildHarness` | `projectPath`, `buildCommand`, `harnessSource`, `targetFile`, `closureFiles?`, `entryStyle` (`single`\|`fuzzer`), `timeoutSec?` | biên dịch+link harness targeted → `binaryPath`, hoặc `reason="harness_unresolvable"` |
| `libfuzzerRun` | `binaryPath`, `maxTotalTimeSec`, `timeoutSec?` | chạy harness (`entryStyle=fuzzer`) trong ngân sách thời gian ngắn |

## Cấu hình (ENV)

Copy `.env.example` → `.env`. **Mọi biến TUỲ CHỌN**. Chi tiết trong [.env.example](.env.example).

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `MCP_HTTP_PORT` | cổng MCP/HTTP (khớp `ports:` trong docker-compose) | `50062` |
| `RUNS_DIR` | thư mục artifact (**container bị compose ép `/runs`**) | `./runs` |
| `DYNAMIC_BUILD_NETWORK` | network mode container build: `none\|host\|bridge` | `none` |
| `DYNAMIC_BUILD_MEMORY` | trần RAM container build | `1g` |
| `DYNAMIC_BUILD_PIDS` | trần process container build | `512` |
| `DYNAMIC_ULIMIT` | đặt `off` để tắt ulimit khi chạy binary | *(bật)* |
| `DYNAMIC_ULIMIT_AS_KB` | trần address-space khi chạy (KB) | `2097152` |
| `DYNAMIC_ULIMIT_FSIZE_KB` | trần file ghi (KB) | `262144` |
| `DYNAMIC_ULIMIT_NPROC` | trần số process | `512` |

## Chạy

```bash
# Docker (cách dùng chính — Linux/Docker-only)
docker compose up --build dynamic-analyzer

# Host Linux (đọc apps/dynamic-analyzer/.env qua dotenv của main.ts)
turbo run dev --filter=dynamic-analyzer
```

## Ghi chú

- **MCP-only** (gRPC/proto đã gỡ). `main.ts` dựng DI context rồi serve MCP.
- Trong container, `RUNS_DIR` được docker-compose ép `/runs` (điểm mount của named-volume
  `runs:`) — đè giá trị host `./runs` trong `.env`.
- Tài liệu: [docs/SECURITY.md](../../docs/SECURITY.md) ·
  [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).
