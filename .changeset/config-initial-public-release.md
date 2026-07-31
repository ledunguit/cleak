---
"@cleak/config": minor
---

First public release of `@cleak/config`: centralized config schema (Zod), JSON loader/persister at
`~/.config/cleak/config.json` (with backup, forward-compat lenient parse, and a TOCTOU guard), CLI
helpers (`config init/get/set/unset`), and a `toProviderSettings` converter for `@cleak/agent-core`.
Previously internal-only (`private: true`); now published standalone in addition to being bundled
inline into `@cleak/cli`.
