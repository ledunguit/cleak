# Baseline Design for LLM Orchestrator Memory Leak Detection

## Baseline 1 – Static Analysis Only

### Configuration

```yaml
planner: false
tool_selector: false

static: true
dynamic: false

fusion: false
```

### Pipeline

```text
Source Code
      │
      ▼
 Static Analyzer
 (Cppcheck / Clang SA)
      │
      ▼
 Detection Result
```

### Purpose

Evaluate the capability of a standalone static analyzer for detecting memory leaks.

---

# Baseline 2 – Dynamic Analysis Only

### Configuration

```yaml
planner: false
tool_selector: false

static: false
dynamic: true

fusion: false
```

### Pipeline

```text
Source Code
      │
      ▼
 Dynamic Analyzer
 (Valgrind / AddressSanitizer)
      │
      ▼
 Detection Result
```

### Purpose

Measure the capability of standalone dynamic analysis.

---

# Baseline 3 – Rule-based Static + Dynamic Ensemble

### Configuration

```yaml
planner: false
tool_selector: false

static: true
dynamic: true

fusion: false
```

### Pipeline

```text
Source Code
      │
      ├───────────────┐
      ▼               ▼
 Static Tool     Dynamic Tool
      │               │
      └──────┬────────┘
             ▼
      Rule-based Merge
      (OR / Majority Vote)
             │
             ▼
      Detection Result
```

### Purpose

Evaluate whether simply combining multiple analyzers without LLM reasoning can improve detection performance.

---

# Baseline 4 – LLM + Static Analysis

### Configuration

```yaml
planner: false
tool_selector: false

static: true
dynamic: false

fusion: true
```

### Pipeline

```text
Source Code
      │
      ▼
 Static Analyzer
      │
      ▼
 LLM Evidence Fusion
      │
      ▼
 Final Leak Decision
```

### Purpose

Evaluate the contribution of LLM reasoning when only static analysis evidence is available.

---

# Baseline 5 – LLM + Dynamic Analysis

### Configuration

```yaml
planner: false
tool_selector: false

static: false
dynamic: true

fusion: true
```

### Pipeline

```text
Source Code
      │
      ▼
 Dynamic Analyzer
      │
      ▼
 LLM Evidence Fusion
      │
      ▼
 Final Leak Decision
```

### Purpose

Evaluate the contribution of LLM reasoning when only dynamic analysis evidence is available.

---

# Baseline 6 – LLM + All Tools (No Planner)

### Configuration

```yaml
planner: false
tool_selector: false

static: true
dynamic: true

fusion: true
```

### Pipeline

```text
Source Code
      │
      ├───────────────┐
      ▼               ▼
 Static Tool     Dynamic Tool
      │               │
      └──────┬────────┘
             ▼
      LLM Evidence Fusion
             │
             ▼
      Final Leak Decision
```

### Purpose

Evaluate whether simply executing all available tools and asking the LLM to summarize their outputs is sufficient.

This baseline removes adaptive planning and adaptive tool selection.

---

# Baseline 7 – Proposed Adaptive LLM Orchestrator

### Configuration

```yaml
planner: true
tool_selector: true

static: true
dynamic: true

fusion: true
```

### Pipeline

```text
Source Code
      │
      ▼
  LLM Planner
      │
      ▼
 Tool Selector
      │
      ▼
 MCP Orchestrator
      │
      ├───────────────┐
      ▼               ▼
 Static Tool     Dynamic Tool
      │               │
      └──────┬────────┘
             ▼
      Evidence Fusion
             │
             ▼
      Final Leak Decision
```

### Purpose

Evaluate the proposed adaptive orchestration framework that:

- Generates hypotheses from source code.
- Dynamically selects analysis tools.
- Coordinates tool execution through MCP.
- Aggregates heterogeneous evidence using LLM reasoning.
- Produces the final memory leak detection result.

---

# Summary

| Baseline | Planner | Tool Selection | Static | Dynamic | LLM Fusion |
|-----------|----------|----------------|---------|----------|------------|
| Baseline 1 – Static Only | ❌ | ❌ | ✅ | ❌ | ❌ |
| Baseline 2 – Dynamic Only | ❌ | ❌ | ❌ | ✅ | ❌ |
| Baseline 3 – Rule-based Ensemble | ❌ | ❌ | ✅ | ✅ | ❌ (Rule-based) |
| Baseline 4 – LLM + Static | ❌ | ❌ | ✅ | ❌ | ✅ |
| Baseline 5 – LLM + Dynamic | ❌ | ❌ | ❌ | ✅ | ✅ |
| Baseline 6 – LLM + All Tools | ❌ | ❌ | ✅ | ✅ | ✅ |
| Baseline 7 – Proposed Method | ✅ | ✅ | ✅ | ✅ | ✅ |