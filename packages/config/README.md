# @cleak/config

Quản lý **cấu hình tập trung** cho toàn bộ hệ thống: schema Zod, loader/persister đọc-ghi
`~/.config/cleak/config.json`, helper CLI (`cleak config init/get/set/unset`), và converter
sang `ProviderSettings` cho `@cleak/agent-core`. `leak-inspector-tui` xây trên package này —
đây là **nguồn sự thật duy nhất** cho cấu hình runtime (không còn đọc `.env`).

Publish lên npm độc lập (`@cleak/config`); đồng thời được `tsup` của `@cleak/cli` inline trực
tiếp vào bundle (`noExternal: [/^@cleak\//]`) nên CLI không phụ thuộc bản npm này lúc chạy.

## Kiến trúc

```
src/
  schema.ts              CleakConfigSchema (Zod), DEFAULT_CONFIG, PROVIDERS
  types.ts                họ type RunConfig (CleakConfig, EndpointOverride, …)
  loader.ts               loadConfig(): CLI flag > file > default; resolveProvider(), clampConfig()
  persist.ts              loadConfigFile/saveConfigFile: backup, lenient forward-compat parse, TOCTOU guard
  cli.ts                   setConfigKey/unsetConfigKey (dot-path, vd. consensus.n), configTemplate
  to-provider-settings.ts toProviderSettings(): CleakConfig → ProviderSettings cho agent-core
  index.ts                 barrel export
```

## API chính

| Symbol | Loại | Vai trò |
|---|---|---|
| `loadConfig(cliOverrides?)` | function | hợp nhất CLI flag > file > default thành config hiệu lực |
| `loadConfigFile()` / `saveConfigFile(data, opts?)` | function | đọc/ghi `~/.config/cleak/config.json` (có backup + TOCTOU guard) |
| `resolveProvider(config)` | function | chọn provider LLM hiệu lực theo config |
| `clampConfig(config)` | function | ràng buộc giá trị số (consensus.n, timeout, …) về vùng hợp lệ |
| `setConfigKey(dotPath, rawValue)` / `unsetConfigKey(dotPath)` | function | set/unset một key theo dot-path, có validate + coerce qua schema |
| `configTemplate()` | function | sinh template đầy đủ key cho `config init` |
| `redactConfig(config)` | function | ẩn secret (API key) khi in/log config |
| `toProviderSettings(config)` | function | chuyển `CleakConfig` sang `ProviderSettings` của `@cleak/agent-core` |
| `CleakConfigSchema`, `DEFAULT_CONFIG`, `PROVIDERS` | Zod schema / const | nguồn sự thật cho shape + default + danh sách provider |
| `CleakConfig`, `EndpointOverride`, … | type | hợp đồng dữ liệu config |

## Cấu hình

File cấu hình duy nhất: `~/.config/cleak/config.json`. Không có `.env` — biến `EVAL_STATIC_URL`,
`EVAL_DYNAMIC_URL`, `RESULTS_DIR` là override dành riêng cho các script trong `scripts/`, đọc qua
`loadConfig()`.

## Build / test

```bash
turbo run build --filter=@cleak/config    # tsup bundle
turbo run typecheck --filter=@cleak/config
```
