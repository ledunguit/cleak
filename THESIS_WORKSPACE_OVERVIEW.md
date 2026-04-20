# Thesis Workspace Overview

## Purpose

`Thesis` is the root workspace for a Master's thesis on LLM-orchestrated
memory leak investigation for C/C++ repositories.

This root repository is not intended to be the main implementation repo for a
single component. It exists as an umbrella workspace to keep multiple related
repositories together under one thesis-level structure:

- orchestration and judging
- static analysis MCP servers
- dynamic analysis MCP servers
- shared schemas and contracts
- historical and experimental leak analysis code

Its role is to make the full thesis system easier to develop, compare, and run
as one coordinated workspace.

## Workspace Structure

The current workspace is organized around these repositories:

### `MCP-Vul`

Current role:

- central control plane for memory leak investigation
- repository-level scanning workflow
- candidate management and evidence aggregation
- future judge, explanation, and fix-suggestion layer

This repo is moving away from embedded analyzer implementations and toward
external MCP server consumption.

### `mcp-memory-static-analysis-server`

Current role:

- static MCP server for memory leak investigation
- repository indexing
- lightweight candidate discovery
- AST-based structural context extraction
- LeakGuard execution/report adapter

Planned direction:

- call graph and interprocedural analysis
- path and constraint analysis
- richer interprocedural memory ownership analysis

### `mcp-dynamic-analysis-server`

Current role:

- dynamic MCP server
- Valgrind / ASan style execution tooling
- normalized dynamic findings
- artifact and run management
- leak bundle retrieval for the orchestrator

### `mcp-memory-common`

Current role:

- shared leak-centric schema package
- common models for candidates, evidence, bundles, verdicts, and locations

This repo exists to prevent the static server, dynamic server, and orchestrator
from drifting into incompatible output formats.

### `leak_guard_tool`

Current role:

- existing memory leak analysis codebase used as a source of static-analysis
  ideas and future MCP tool integration

This repository is not the thesis control plane. It is a separate analyzer code
source that can be wrapped and exposed through MCP later.

## System Intent

The thesis system is being shaped around a clear separation of concerns:

1. analyzer servers produce findings and evidence
2. the orchestrator decides what to investigate next
3. findings are normalized into shared leak bundles
4. a judge produces a final verdict and explanation

The intended end-user workflow is:

1. provide a C/C++ repository
2. discover as many memory leak candidates as possible
3. expand evidence with static and dynamic tools
4. cluster related findings
5. return verdicts, explanations, and repair guidance

## Deployment Direction

The target deployment model is service-oriented:

- `MCP-Vul` acts as the central coordinator
- static and dynamic analyzers run as independent MCP servers
- those servers can be deployed in separate Docker Compose stacks
- communication should prefer MCP over HTTP rather than in-process execution

This root workspace exists partly to support that architecture during thesis
development, where multiple repositories evolve in parallel but still need to be
tested together.

## Why This Root Repository Exists

This root repository is meant to provide:

- one thesis-level Git workspace
- consistent top-level metadata
- a place to manage related repos as submodules
- shared documentation about the overall architecture
- a stable view of how the repositories fit together

It should describe the thesis system at the workspace level, while detailed
implementation remains inside the individual repositories.
