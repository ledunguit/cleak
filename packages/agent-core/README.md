# @cleak/agent-core

Lõi **agentic không phụ thuộc framework**: vòng lặp **native tool-calling**, **MCP client**,
và `callModel` **đa provider** (streaming, idle-timeout, nén ngữ cảnh). `leak-inspector-tui`
xây trên package này; bản thân nó **không biết gì về memory leak** — chỉ là cơ chế điều phối
mô hình ↔ tool có thể tái dùng.

Publish lên npm cùng CLI (`@cleak/agent-core`); trong monorepo build bằng `tsup`.

## Kiến trúc

```
src/
  loop.ts            queryLoop(): async-generator một lượt = stream → gọi tool → kết quả → lặp
  tool.ts            trừu tượng Tool + buildTool() (default an toàn)
  types.ts           Message, ContentBlock, ToolUse/ToolResult, AgentEvent, Usage, …
  deps.ts            CallModel + các cổng phụ thuộc (inject được)
  providers/         buildCallModel() → local | openai | anthropic | openai-compat
    openaiChat.ts    đường chat-completions (local/openai/compat)
    anthropic.ts     Messages API
    normalize.ts     đổi qua lại message/tool giữa các provider
    transport.ts     fetchWithRetry (retry lỗi tạm thời)
  compaction.ts      nén transcript khi vượt ngưỡng token (estimateTokens, pruneStaleToolResults)
  concurrency.ts     mapWithLimit() — fan-out có giới hạn
  mcp/mcpClient.ts   McpClient: Streamable-HTTP, retry transient (MCP_MAX_RETRIES)
  mcp/mcpToolAdapter.ts  loadMcpTools()/wrapMcpTool(): tools/list của MCP → Tool[]
```

## API chính

| Symbol | Loại | Vai trò |
|---|---|---|
| `queryLoop(params)` | `async function*` | vòng lặp agent: yield `AgentEvent`, trả `LoopResult` |
| `buildCallModel(settings, uuid?, onNotice?)` | function | dựng `CallModel` từ `ProviderSettings` (local/openai/anthropic/compat) |
| `buildTool(def)` | function | tạo `Tool` với default an toàn |
| `loadMcpTools(client, flagResolver?)` | async function | nạp tool từ MCP server thành `Tool[]` |
| `wrapMcpTool(...)` | function | bọc 1 MCP tool thành `Tool` (kèm cờ permission/format) |
| `McpClient` | class | client Streamable-HTTP (`McpClientOptions`) |
| `Tool`, `ToolCtx`, `Message`, `AgentEvent`, `Usage`, `LoopResult` | type/interface | hợp đồng dữ liệu của loop |
| `mapWithLimit(items, n, fn)` | function | chạy song song có trần đồng thời |
| `estimateTokens`, `pruneStaleToolResults`, `truncateResult` | function | tiện ích nén/cắt ngữ cảnh |
| `isTransientError`, `retryTransient` | function | phân loại + retry lỗi mạng/tạm thời |

## Cấu hình (ENV)

Là **thư viện**, không chạy độc lập ⇒ **không có `.env.example`**. Biến env duy nhất:

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `MCP_MAX_RETRIES` | số lần retry khi MCP transport lỗi tạm thời (`mcp/mcpClient.ts`) | `3` |

Tham số provider (base URL, key, model, nhiệt độ, timeout…) truyền qua `ProviderSettings`,
do consumer (TUI) đọc từ env của nó — xem `apps/leak-inspector-tui/.env.example`.

## Build / test

```bash
turbo run build --filter=@cleak/agent-core    # tsup bundle
turbo run test  --filter=@cleak/agent-core    # bun test
```
