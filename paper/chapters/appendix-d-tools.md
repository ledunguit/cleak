# Phụ lục D: Bảng tham chiếu tool MCP

## D.1. Static analyzer — 11 tools

| # | Tool | Chức năng | Content-capable | Phơi cho TUI |
|---|---|---|:--:|:--:|
| 1 | `indexFiles` | Quét đệ quy tất cả file C/C++ từ root path | ❌ | ❌ |
| 2 | `candidateScan` | Lexical scan tìm allocation site (malloc, new, factory) | ✅ | ✅ |
| 3 | `astScan` | Phân tích cấu trúc AST cho memory leak pattern | ✅ | ✅ |
| 4 | `callGraph` | Trích xuất đồ thị gọi hàm | ❌ | ❌ |
| 5 | `functionSummary` | Tóm tắt hàm: alloc/free balance, exit path | ✅ | ✅ |
| 6 | `pathConstraints` | Phân tích ràng buộc đường đi quanh allocation | ✅ | ✅ |
| 7 | `interproceduralFlow` | Truy vết alloc/free liên hàm | ❌ | ❌ |
| 8 | `ownershipSummary` | Tóm tắt quy ước ownership qua nhiều file | ❌ | ❌ |
| 9 | `ownershipConventions` | Phát hiện quy ước transfer ownership trong file | ✅ | ✅ |
| 10 | `scanBuildRun` | Chạy Clang Static Analyzer (scan-build) | ❌ | ❌ |
| 11 | `scanBuildGetReport` | Lấy kết quả scan-build | ❌ | ❌ |

*Content-capable = nhận content inline (không cần mount filesystem). TUI chỉ expose 5 content-capable tools cho sub-agent tĩnh.*

## D.2. Dynamic analyzer — 9 tools

| # | Tool | Chức năng | Serial/Heavy |
|---|---|---|:--:|
| 1 | `buildTarget` | Build dự án với sanitizer flags | ✅ |
| 2 | `valgrindMemcheck` | Chạy Valgrind Memcheck | ✅ |
| 3 | `valgrindGetReport` | Lấy normalized Valgrind report | ❌ |
| 4 | `valgrindListFindings` | Query findings với filter | ❌ |
| 5 | `valgrindCompareRuns` | So sánh hai lần chạy Valgrind | ❌ |
| 6 | `asanRun` | Chạy binary với AddressSanitizer | ✅ |
| 7 | `lsanRun` | Chạy binary với LeakSanitizer | ✅ |
| 8 | `runBinary` | Chạy binary không instrumentation | ❌ |
| 9 | `listRuns` | Liệt kê các lần chạy đã lưu | ❌ |

*Serial/Heavy = chạy tuần tự, timeout 300s, cần phê duyệt (ask).*

## D.3. Tool domain

| Tool | Chức năng | File |
|---|---|---|
| `read_file` | Đọc source file từ repository (tối đa 16000 chars) | `domainTools.ts` |
| `done_static` | Kết thúc vòng lặp static sub-agent | `workflowInvestigation.ts:183` |
| `done_dynamic` | Kết thúc vòng lặp dynamic worker | `workflowInvestigation.ts:233` |

## D.4. Tool execution policy

| Chính sách | Áp dụng | Hành vi |
|---|---|---|
| `CONCURRENCY_SAFE` | Tool read-only nhẹ | Chạy song song, timeout 30s |
| `SERIAL_HEAVY` | build/sanitizer/scan-build | Chạy tuần tự, timeout 300s, cần `ask` |
| Content-capable | 5 static tools | Nhận content inline, không cần filesystem mount |
| Non-content | 6 static tools + dynamic | Cần path map (`EVAL_STATIC_PATH_MAP` trong Docker) |

## D.5. MCP protocol

- **Transport:** Streamable-HTTP, `POST /mcp` (JSON-RPC 2.0, stateless JSON mode)
- **Tool schema:** Zod `inputSchema` → MCP SDK tự convert sang JSON Schema
- **Client:** `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport`
- **Ports:** static-analyzer `:50061`, dynamic-analyzer `:50062`
