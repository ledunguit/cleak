# static-analyzer

Dịch vụ **phân tích tĩnh C/C++** cho luận văn — NestJS, phục vụ **MCP/HTTP trên cổng
50061**. `leak-inspector-tui` điều phối analyzer này hoàn toàn qua MCP; **MCP/HTTP là
transport duy nhất** (server gRPC + `proto/` của bản web cũ đã được gỡ trên `master`).

Nhiệm vụ: từ một repo C/C++, tìm **ứng viên cấp phát** (allocation candidate), dựng bằng
chứng cấu trúc (AST, call graph, ownership, ràng buộc đường đi) và chạy **Clang Static
Analyzer (`scan-build`)** — trả JSON đầy đủ cho orchestrator.

## Kiến trúc nội bộ

```
src/
  main.ts                         nạp apps/static-analyzer/.env (host) → dựng DI context → serveMcp()
  mcp/static-mcp-server.ts        đăng ký 11 MCP tool, delegate sang service
  mcp/mcp-http.ts                 transport Streamable-HTTP
  services/
    file-indexing.service.ts      duyệt repo (lstat + chặn symlink ra ngoài canonical root)
    candidate-scan.service.ts     quét lexical các site cấp phát (+ allocator/deallocator tuỳ dự án)
    ast-scan.service.ts           Tree-sitter AST (C + C++), bắt new/delete, mẫu rò rỉ cấu trúc
    call-graph.service.ts         cạnh/đỉnh call graph, chuỗi reachability alloc→free
    function-summary.service.ts   cân bằng alloc/free, biến cục bộ, lời gọi trong 1 hàm
    interprocedural-flow.service.ts  truy vết dataflow liên thủ tục
    path-constraints.service.ts   phân tích đường đi khả thi quanh site cấp phát (Z3, node-only)
    ownership-analysis.service.ts quy ước chuyển quyền sở hữu (ownership transfer)
    c-parser.service.ts           CFG path-sensitive, reachability dead-code (engine E1–E3)
    scan-build-adapter.service.ts bọc Clang `scan-build` (slot "scan-build" tự chứa)
```

> Tham số `extra*Allocators` / `extra*Deallocators` (≈ **AllocSource/FreeSink** của LAMeD)
> cho phép LLM tầng trên nạp danh sách allocator/deallocator **theo dự án** để engine tất
> định nhận diện wrapper (vd `cJSON_Duplicate`). LLM **đề xuất**, engine **xác minh** —
> xem [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

## MCP tool (11) — I/O

| Tool | Input | Trả về |
|---|---|---|
| `indexFiles` | `rootPath`, `fileLimit?`, `excludePatterns?` | danh sách file C/C++ trong repo |
| `candidateScan` | `filePath`, `content?`, `extraAllocators?`, `extraDeallocators?` | các site cấp phát (malloc/calloc/realloc/strdup/new + wrapper) |
| `astScan` | `filePath`, `content?` | phân tích cấu trúc trên AST (mẫu rò rỉ, new/delete) |
| `callGraph` | `rootPath`, `files`, `extraAllocators?`, `extraDeallocators?` | đỉnh/cạnh call graph + chuỗi alloc→free |
| `functionSummary` | `filePath`, `content?`, `functionName`, `extraAllocators?`, `extraDeallocators?` | cân bằng alloc/free, biến cục bộ, lời gọi |
| `interproceduralFlow` | `rootPath`, `functionName`, `files` | dataflow liên thủ tục |
| `pathConstraints` | `filePath`, `content?`, `lineNumber`, `extraAllocators?`, `extraDeallocators?` | đường đi khả thi quanh dòng cấp phát (Z3) |
| `ownershipSummary` | `files`, `rootPath` | tổng hợp quy ước sở hữu nhiều file |
| `ownershipConventions` | `filePath`, `content?` | quy ước chuyển quyền sở hữu trong 1 file |
| `scanBuildRun` | `projectPath`, `buildCommand`, `timeoutSec?` | chạy Clang `scan-build` trên bản build dự án |
| `scanBuildGetReport` | `runId` | findings của `scan-build` |

## Cấu hình (ENV)

Copy `.env.example` → `.env`. **Mọi biến TUỲ CHỌN** (code có default). Chi tiết trong
[.env.example](.env.example).

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `MCP_HTTP_PORT` | cổng MCP/HTTP (phải khớp `ports:` trong docker-compose) | `50061` |
| `RUNS_DIR` | thư mục lưu báo cáo scan-build | `./runs` |
| `SCAN_BUILD_BIN` | đường dẫn `scan-build` | `scan-build` |
| `EXTRA_ALLOCATOR_NAMES` | allocator tuỳ dự án (CSV) | *(rỗng)* |

## Chạy

```bash
# Host (đọc apps/static-analyzer/.env qua dotenv của main.ts; cwd = repo root)
turbo run dev --filter=static-analyzer        # hoặc: (cd apps/static-analyzer && bun run dev)

# Docker (đọc apps/static-analyzer/.env qua env_file của compose)
docker compose up --build static-analyzer
```

Kiểm tra nhanh tool catalog: `bun scripts/mcp-contract-test.ts`.

## Ghi chú

- **MCP-only.** Server gRPC + `proto/` đã bị xoá khỏi `master` (không còn consumer sau khi
  bỏ bản web). `main.ts` chỉ dựng DI context rồi serve MCP.
- Slot **"scan-build"** giờ là **Clang `scan-build` tự chứa** — submodule third-party
  `tools/leak_guard_tool` đã bị gỡ.
- Tài liệu nguồn: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) ·
  [docs/PROMPTS.md](../../docs/PROMPTS.md) · [docs/SECURITY.md](../../docs/SECURITY.md).
