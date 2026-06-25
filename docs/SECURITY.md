# Security & Trust Model

This system **compiles and executes untrusted C/C++** from whatever repository is
under scan. The **leak-inspector-tui** orchestrator drives that execution from LLM
tool calls, routing build/run requests to the **dynamic-analyzer** over MCP. This
document states the trust boundary it is built for and the controls that enforce
it.

## Trust model

- **Single operator, local/CI use.** The intended deployment is the thesis author
  (or a CI job) scanning repositories *they* selected, on a host or container
  *they* control. It is **not** a multi-tenant or internet-exposed service.
- **The scanned code is untrusted; the operator is trusted.** A malicious repo
  must not be able to escape its analysis sandbox, read host secrets, or persist —
  but the operator's own build commands / API keys are assumed legitimate.

> The earlier web deployment (HTTP API, React UI, PostgreSQL, OAuth) and its
> additional auth-at-rest controls are preserved on the `web-implementation`
> branch; they are out of scope for the TUI-only master described here.

## Controls in place

| Risk | Control | Where |
|---|---|---|
| Shell injection via binary path/args | All binary execution uses `execFile`/`spawn` with an **argv array** — never an interpolated shell string | `apps/dynamic-analyzer/src/services/safe-exec.ts`, valgrind/asan/lsan/binary-runner |
| Runaway / fork-bomb / OOM in scanned binary | `ulimit` confinement (CPU time, address space, file size, process count) on Linux | `safe-exec.ts` (`DYNAMIC_ULIMIT_*` env) |
| Build-time escape | Docker build runs `--network none` + bounded `--memory`/`--pids-limit`; mount source is `realpath`-canonicalized; docker args passed as an array | `apps/dynamic-analyzer/src/services/build-target.service.ts` |
| Path traversal via symlinks | Repo indexing uses `lstat` + a canonical-root containment check; symlinks pointing outside the repo are skipped | `apps/static-analyzer/src/services/file-indexing.service.ts` |
| `scan-build` shell injection | `spawnSync` with argv; the build command keeps one intended `/bin/sh -c` layer (a single argv element, nothing to escape) | `apps/static-analyzer/src/services/leakguard-adapter.service.ts` |
| Run id → filesystem path | `sanitizeRunId` strips to `[A-Za-z0-9_]` before building `/tmp/<id>.xml` | `safe-exec.ts`, `valgrind.service.ts` |
| Analyzer ports on the LAN | MCP ports published to `127.0.0.1` only in docker-compose | `docker-compose.yml` |

## Known limitations (acceptable under the trust model; fix before exposure)

- **No network isolation for host-run binaries.** The `ulimit` wrapper bounds CPU/
  memory/processes but not network. A scanned binary run directly on the host (not
  via the Docker path) can make outbound connections. For stronger isolation, run
  the dynamic stage entirely in a network-less container.
- **MCP analyzers are unauthenticated.** The static- and dynamic-analyzer MCP
  servers trust their caller (the TUI); keep them bound to localhost / the
  internal docker network. (The analyzers' legacy gRPC server code is still
  present but has no consumer on master.)

## Required configuration before any non-local use

1. Do not publish analyzer MCP ports beyond localhost; if the analyzers must be
   reachable, put them behind an authenticating reverse proxy.
2. Run the dynamic stage inside a network-less container for any untrusted repo.
3. Keep the LLM API key (read from `<root>/.env` or `apps/leak-inspector-tui/.env`)
   out of version control and scoped to the operator.
