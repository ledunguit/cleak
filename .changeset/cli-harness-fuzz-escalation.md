---
"@cleak/cli": minor
---

Harness + fuzz-tier escalation stages wired into the investigation workflow and eval runner, a
new eval setup screen, a preflight UX overhaul (parallel LLM/static/dynamic checks with
independent live status per check), and sticky header/footer flicker-free rendering (alt-screen,
`TerminalSizeContext`, BSU/ESU).

Migrated onto `@cleak/config` as the single source of truth for runtime configuration.

**Breaking:** `.env` file support has been removed — use `cleak config init/get/set/unset` or edit
`~/.config/cleak/config.json` directly instead.
