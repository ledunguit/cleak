# @cleak/config

## 0.2.0

### Minor Changes

- [`adcbeff`](https://github.com/ledunguit/cleak/commit/adcbeff7e769aea0182f253def9e8a1f28f9a148) Thanks [@ledunguit](https://github.com/ledunguit)! - First public release of `@cleak/config`: centralized config schema (Zod), JSON loader/persister at
  `~/.config/cleak/config.json` (with backup, forward-compat lenient parse, and a TOCTOU guard), CLI
  helpers (`config init/get/set/unset`), and a `toProviderSettings` converter for `@cleak/agent-core`.
  Previously internal-only (`private: true`); now published standalone in addition to being bundled
  inline into `@cleak/cli`.

### Patch Changes

- Updated dependencies [[`adcbeff`](https://github.com/ledunguit/cleak/commit/adcbeff7e769aea0182f253def9e8a1f28f9a148)]:
  - @cleak/common@0.5.0
