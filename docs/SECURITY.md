# Security & Trust Model

This system **compiles and executes untrusted C/C++** from whatever repository is
under scan. The **leak-inspector-tui** orchestrator drives that execution, routing
build/run requests to the **dynamic-analyzer** over MCP. This document states the
trust boundary it is built for and the controls that enforce it.

> **Both analysis modes can execute code.** `llm_assisted` runs the dynamic stage
> from LLM tool calls; `no_llm` runs a **deterministic** dynamic stage (build →
> LSan, no LLM) when invoked with `--dynamic ≠ off` AND a known `buildCommand`.
> The execution path + confinement are identical. By default (`--dynamic off`, or no
> `buildCommand`) `no_llm` is **static-only and never executes the scanned code**.

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
| Runaway / fork-bomb / OOM in scanned binary | `ulimit` confinement (CPU time, file size, process count) on Linux. The **address-space** (`-v`) cap is dropped ONLY for sanitizer/valgrind runs (`unlimitedAddressSpace`) because ASan/LSan reserve ~20 TB of *virtual* shadow memory — the cap aborts them; physical RSS is still container-bounded and CPU/fsize/proc limits stay | `safe-exec.ts` (`DYNAMIC_ULIMIT_*` env) |
| Build-time escape | Docker build runs `--network none` + bounded `--memory`/`--pids-limit`; mount source is `realpath`-canonicalized; docker args passed as an array | `apps/dynamic-analyzer/src/services/build-target.service.ts` |
| Path traversal via symlinks | Repo indexing uses `lstat` + a canonical-root containment check; symlinks pointing outside the repo are skipped | `apps/static-analyzer/src/services/file-indexing.service.ts` |
| `scan-build` shell injection | `spawnSync` with argv; the build command keeps one intended `/bin/sh -c` layer (a single argv element, nothing to escape) | `apps/static-analyzer/src/services/scan-build-adapter.service.ts` |
| Run id → filesystem path | `sanitizeRunId` strips to `[A-Za-z0-9_]` before building `/tmp/<id>.xml` | `safe-exec.ts`, `valgrind.service.ts` |
| Analyzer ports on the LAN | MCP ports published to `127.0.0.1` only in docker-compose | `docker-compose.yml` |
| Compiling/running an ORCHESTRATOR-GENERATED harness | Same argv-only, no-shell, `ulimit`-confined `runConfined` used for sanitizer runs — see "Targeted harness synthesis" below | `apps/dynamic-analyzer/src/services/harness-build.service.ts`, `compile-commands.service.ts` |

## Targeted harness synthesis (Stage B2, opt-in)

`workflow.targetedHarness.enabled` (off by default — `--harness` / `cleak config set
workflow.targetedHarness.enabled true`) adds a new code-execution surface beyond the
scanned repo's own build: for a candidate static analysis is unsure about, an LLM
sub-agent writes a SMALL C/C++ driver (`buildHarness`'s `harnessSource`) that gets
compiled and run. This is the first place the pipeline executes code it did not
receive verbatim from the scanned repository — it warrants its own entry.

- **Compilation is NOT a nested Docker container.** `buildTarget`'s Docker-in-Docker
  path (`buildWithDocker`, spawning `docker run gcc:latest`) exists only for
  macOS-native dev outside docker-compose — the deployed `dynamic-analyzer` image has
  no `docker` CLI and no `/var/run/docker.sock` mount, so nested Docker is not
  reachable from inside it. `HarnessBuildService` and `CompileCommandsService`
  therefore compile via the SAME confined `runConfined` (`safe-exec.ts`) used for
  running sanitizer binaries: argv-array `execFile` (no shell for the outer call),
  `ulimit`-wrapped on Linux (CPU time, address space, file size, process count).
  `bear -- sh -c '<buildCommand>'` is the one place a shell reappears — `sh -c`
  interprets `buildCommand`'s OWN syntax, exactly as `BuildTargetService`'s existing
  `execSync(buildCommand, …)` already does; this doesn't add injection surface
  beyond what `buildTarget` already carries (the build command is operator-supplied,
  not attacker-supplied).
- **Path containment.** `HarnessBuildService` resolves `targetFile`/`closureFiles`
  against `realpathSync(projectPath)` and rejects anything that resolves outside it,
  so a harness-authoring LLM cannot point compilation at an arbitrary host path.
- **Compiled harnesses run through the identical sanitizer-execution path** as
  `lsanRun`/`asanRun` (same `runConfined`, same `unlimitedAddressSpace` handling) —
  no separate, less-audited execution path was added for harness binaries.
- **Not yet covered** (same limitation as the rest of the dynamic stage): no network
  isolation on the host-run path — see "No network isolation" below, which now also
  applies to compiled harness binaries, not just the scanned project's own binary.
  A network-isolated container path for harness compile+run is future work if this
  moves beyond single-operator/local use.

## Known limitations (acceptable under the trust model; fix before exposure)

- **No network isolation for host-run binaries.** The `ulimit` wrapper bounds CPU/
  memory/processes but not network. A scanned binary run directly on the host (not
  via the Docker path) can make outbound connections. For stronger isolation, run
  the dynamic stage entirely in a network-less container.
- **MCP analyzers are unauthenticated.** The static- and dynamic-analyzer MCP
  servers trust their caller (the TUI); keep them bound to localhost / the
  internal docker network. (MCP/HTTP is the only transport — the legacy gRPC
  server code has been removed.)

## Required configuration before any non-local use

1. Do not publish analyzer MCP ports beyond localhost; if the analyzers must be
   reachable, put them behind an authenticating reverse proxy.
2. Run the dynamic stage inside a network-less container for any untrusted repo.
3. Keep the LLM API key (stored in `~/.config/cleak/config.json`, chmod 600)
   out of version control and scoped to the operator.
