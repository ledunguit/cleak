# Thesis Implementation TODO

This checklist tracks the remaining work from the current executable slice to a
complete thesis demo for LLM-orchestrated memory leak investigation.

## Phase 1: Control Plane Foundation

- [x] Create thesis workspace root and architecture overview
- [x] Split the architecture into control plane, static server, dynamic server, and shared schema
- [x] Add a shared leak-centric schema package
- [x] Add HTTP MCP connectivity for `MCP-Vul`
- [x] Add a first repo-level memory leak control-plane scan path
- [x] Add candidate clustering and evidence aggregation
- [x] Narrow `MCP-Vul` active README, CLI, tests, and package build to memory-leak-only scope
- [x] Audit legacy multi-CWE MVP code and mark it as historical/out-of-scope
- [x] Move legacy multi-CWE MVP code/docs/tests/data/experiments into `legacy/multi_cwe_mvp/`

## Phase 2: Static Analysis Server

- [x] Create `mcp-memory-static-analysis-server`
- [x] Add `repo.index_files`
- [x] Add `memory.candidate_scan`
- [x] Add `memory.ast_scan`
- [x] Add `memory.function_summary`
- [x] Add `memory.call_graph`
- [x] Add `memory.path_constraints`
- [x] Add Docker / Docker Compose packaging
- [x] Add `memory.leakguard_run`
- [x] Add `memory.leakguard_get_report`
- [x] Add `memory.interprocedural_flow`
- [x] Add `memory.call_path_summary`
- [ ] Normalize all static tools to the shared schema directly where possible

## Phase 3: Dynamic Analysis Server

- [x] Normalize dynamic leak bundles for Memcheck / ASan
- [x] Expose `memory.get_leak_bundles`
- [x] Add `lsan.run`
- [x] Add a generic binary / harness execution path
- [x] Add run selection and filtering helpers for orchestrator use
- [x] Add stronger artifact metadata for bundle traceability

## Phase 4: Cross-Tool Clustering

- [x] Merge lexical/static bundles by allocation-site identity
- [x] Merge LeakGuard and dynamic findings into the same bundle when they match
- [x] Improve clustering with safer file identity checks
- [ ] Improve clustering with call-path hints, variable names, and function names
- [x] Add explicit bundle provenance history
- [x] Add false-merge regression tests

## Phase 5: Judge Layer

- [x] Add an initial heuristic leak judge
- [x] Add an LLM leak judge that consumes `LeakBundle`
- [x] Keep heuristic judge as fallback
- [x] Add confidence calibration rules between heuristic and LLM outputs
- [x] Add a structured explanation contract for the judge

## Phase 6: Explanation and Fix Suggestions

- [x] Add first pass fix suggestions from heuristic judge
- [x] Improve explanation quality with allocation-site, cleanup-path, and branch reasoning
- [x] Add repair suggestions that reference specific target locations
- [x] Separate “why this is a leak” from “how to fix it”

## Phase 7: Repo Intake and Execution Policy

- [x] Support repo-level scan input
- [x] Support optional `build_command` forwarding to project-level analyzers
- [x] Add compile database discovery policy
- [x] Add repo intake metadata and scan manifests
- [x] Add orchestrator task states:
  - `new`
  - `needs_static_expansion`
  - `needs_dynamic_validation`
  - `ready_for_judge`
  - `closed`
- [x] Add tool-invocation policy metadata
- [x] Add adaptive tool-invocation policy instead of fixed linear execution
- [x] Add tool invocation trace with reasons and durations

## Phase 8: Reporting

- [x] Emit machine-readable JSON report from control plane
- [x] Add markdown report renderer
- [x] Add HTML summary report for thesis demo
- [x] Add per-candidate supporting evidence sections
- [x] Add per-candidate artifact links

## Phase 9: Deployment and Integration

- [x] Support HTTP MCP server deployment
- [x] Add Docker Compose for static server
- [x] Add Docker Compose for dynamic server
- [x] Add Compose examples for full multi-service thesis demo
- [x] Define container/network expectations for LeakGuard execution

## Phase 10: Evaluation Readiness

- [x] Build a repeatable benchmark/demo corpus for memory leaks
- [x] Add result snapshot format for thesis experiments
- [x] Add comparison mode between static-only, dynamic-only, and orchestrated flow
- [x] Add thesis-demo scripts for one-command end-to-end runs
- [x] Add corpus manifest batch runner for repeatable evaluation
- [x] Add count-based ground-truth summary for corpus cases
- [x] Add verdict quality checks for supporting evidence, explanation, and fix suggestions

## Phase 11: Application Backend

- [x] Create a dedicated application backend package / service for the UI
- [x] Add workspace discovery API:
  - list allowed local workspaces
  - validate selected repository path
  - detect C/C++ source files before starting a scan
- [x] Add scan job API:
  - `POST /api/scans`
  - `GET /api/scans/{scan_id}`
  - `GET /api/scans/{scan_id}/events`
  - `GET /api/scans/{scan_id}/report`
- [x] Add scan job state model:
  - `queued`
  - `starting`
  - `indexing`
  - `static_analysis`
  - `leakguard_analysis`
  - `dynamic_merge`
  - `judging`
  - `reporting`
  - `completed`
  - `failed`
  - `cancelled`
- [x] Add persistent scan storage:
  - request metadata
  - selected workspace
  - orchestrator tool invocation trace
  - progress events
  - JSON / Markdown / HTML / snapshot reports
- [x] Add progress/event streaming via Server-Sent Events or WebSocket
- [x] Add best-effort cancellation support for queued/running scans
- [x] Add process-backed scan workers so the app can terminate in-flight orchestration jobs
- [x] Add backend integration with `MCP-Vul` control plane without importing analyzer implementations directly
- [x] Add backend tests with fake MCP clients and deterministic scan outputs
- [x] Reject duplicate active scans for the same workspace
- [ ] Propagate cancellation into remote analyzer servers so server-side subprocesses/containers also stop early

## Phase 12: Application Frontend

- [x] Create a frontend app for thesis demo usage
- [x] Add workspace selection screen:
  - choose from allowed mounted workspaces
  - show repo metadata and detected C/C++ file count
  - configure optional build command
- [x] Add scan launch flow:
  - start scan
  - show active scan id
- [x] Prevent duplicate accidental scans for the same workspace
- [x] Add live progress screen:
  - current phase
  - progress timeline
  - streaming logs
  - MCP tool calls and durations
  - candidate count and evidence count as they become available
- [x] Add first report viewer:
  - verdict summary
  - candidate list
  - per-candidate evidence
  - allocation site and missing cleanup path
  - judge explanation
  - fix suggestions
  - artifact links
- [x] Add report export actions:
  - JSON
  - Markdown
  - HTML
  - snapshot
- [x] Add first-pass failure states:
  - MCP server unavailable
  - invalid workspace
  - LeakGuard Docker unavailable
  - build command failure
  - judge/LLM failure with heuristic fallback notice
- [x] Add typed failure categories and remediation hints for each backend/tool failure
- [ ] Add UI tests for scan lifecycle and report rendering

## Phase 13: App Deployment and Demo Flow

- [x] Add Dockerfile / Compose service for the application backend
- [x] Serve the first frontend from the application backend for the thesis demo
- [x] Add full demo Compose stack:
  - UI frontend
  - app backend
  - static MCP server
  - dynamic MCP server
  - mounted workspace volume
  - scan artifact volume
- [x] Add `.env.example` for app-level configuration:
  - allowed workspace roots
  - MCP server URLs
  - scan artifact directory
  - judge mode
  - LLM provider variables
- [x] Add one-command local app script
- [x] Add user-facing README section for running the app workflow
- [x] Add one-command thesis demo script that starts all services
- [ ] Optionally add host-specific browser opening to the demo script

## Remaining Research-Quality Hardening

- [ ] Replace heuristic static analyzers with deeper cross-translation-unit ownership analysis
- [ ] Add automatic dynamic harness discovery/build execution instead of requiring pre-existing run ids
- [ ] Add ground-truth scoring metrics against labeled benchmark corpora
- [ ] Add LLM-orchestrator planner loop that can revise tool calls from intermediate findings

## Immediate Next Steps

- [x] Decide app stack and directory layout
- [x] Implement application backend scan job API first
- [x] Add persistent scan event log and report artifact storage
- [x] Build the first frontend screen for workspace selection and scan launch
- [x] Build progress/log streaming screen
- [x] Build report viewer screen
- [x] Add app backend Dockerfile and compose service
- [x] Add first-pass UI failure states and scan de-duplication
- [x] Add process-backed cancellation across app worker scans
- [ ] Add remote analyzer cancellation across static/dynamic server subprocesses/containers
