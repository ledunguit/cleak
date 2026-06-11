# Security & Trust Model

This system **compiles and executes untrusted C/C++** from whatever repository is
under scan, and drives that execution from LLM tool calls. This document states
the trust boundary it is built for and the controls that enforce it.

## Trust model

- **Single operator, local/CI use.** The intended deployment is the thesis author
  (or a CI job) scanning repositories *they* selected, on a host or container
  *they* control. It is **not** a multi-tenant or internet-exposed service.
- **The scanned code is untrusted; the operator is trusted.** A malicious repo
  must not be able to escape its analysis sandbox, read host secrets, or persist —
  but the operator's own build commands / API keys are assumed legitimate.

## Controls in place

| Risk | Control | Where |
|---|---|---|
| Shell injection via binary path/args | All binary execution uses `execFile`/`spawn` with an **argv array** — never an interpolated shell string | `apps/dynamic-analyzer/src/services/safe-exec.ts`, valgrind/asan/lsan/binary-runner |
| Runaway / fork-bomb / OOM in scanned binary | `ulimit` confinement (CPU time, address space, file size, process count) on Linux | `safe-exec.ts` (`DYNAMIC_ULIMIT_*` env) |
| Build-time escape | Docker build runs `--network none` + bounded `--memory`/`--pids-limit`; mount source is `realpath`-canonicalized; docker args passed as an array | `build-target.service.ts` |
| Git argument/command injection | Branch + URL validated against an allowlist regex; `git` invoked via argv with `--` separators | `github.service.ts`, `persistence.service.ts` |
| Path traversal via symlinks | Repo indexing uses `lstat` + a canonical-root containment check; symlinks pointing outside the repo are skipped | `file-indexing.service.ts` |
| `scan-build` shell injection | `spawnSync` with argv; the build command keeps one intended `/bin/sh -c` layer (a single argv element, nothing to escape) | `leakguard-adapter.service.ts` |
| Run id → filesystem path | `sanitizeRunId` strips to `[A-Za-z0-9_]` before building `/tmp/<id>.xml` | `safe-exec.ts`, `valgrind.service.ts` |
| OAuth tokens at rest | AES-256-GCM column transformer when `TOKEN_ENC_KEY` is set | `packages/common/src/entities/encrypted-column.ts` |
| Insecure defaults shipped silently | Startup warns on default `JWT_SECRET`, `DB_SYNC=true`, missing `TOKEN_ENC_KEY` | `control-plane/src/main.ts` |
| DB schema auto-sync data loss | `synchronize` defaults **off**; opt in with `DB_SYNC=true` for throwaway DBs only | `control-plane.module.ts` |
| Analyzer ports on the LAN | gRPC/MCP ports published to `127.0.0.1` only in docker-compose | `docker-compose.yml` |

## Known limitations (acceptable under the trust model; fix before exposure)

- **No network isolation for host-run binaries.** The `ulimit` wrapper bounds CPU/
  memory/processes but not network. A scanned binary run directly on the host (not
  via the Docker path) can make outbound connections. For stronger isolation, run
  the dynamic stage entirely in a network-less container.
- **SSE endpoints are unauthenticated** (`@Public()` on `/api/scans/:id/events`
  and the workspace `llm-analyze` stream). `EventSource` can't send an
  `Authorization` header, so these rely on the API not being network-exposed
  rather than on auth. Do not expose the control-plane publicly without adding a
  query-token (or cookie) check here.
- **gRPC/MCP analyzers are unauthenticated.** They trust their caller; keep them
  bound to localhost / the internal docker network.

## Required configuration before any non-local use

1. Set a strong `JWT_SECRET`.
2. Set `TOKEN_ENC_KEY` (any high-entropy string) so OAuth tokens are encrypted.
3. Keep `DB_SYNC` unset (use migrations) for any persistent database.
4. Do not publish analyzer ports beyond localhost; put the API behind an
   authenticating reverse proxy if it must be reachable.
