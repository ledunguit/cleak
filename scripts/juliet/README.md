# Juliet CWE-401 benchmark

Evaluate the leak investigator on the NIST Juliet C/C++ memory-leak testcases
(CWE-401, "Missing Release of Memory after Effective Lifetime").

## 1. Download Juliet (public domain)

Juliet is released by NIST SAMATE into the public domain (CC0 / 17 USC 105).

```bash
curl -L -o juliet.zip \
  https://samate.nist.gov/SARD/downloads/test-suites/2017-10-01-juliet-test-suite-for-c-cplusplus-v1-3.zip
unzip -q juliet.zip -d /tmp/juliet           # ~146 MB extracted
```

The CWE-401 testcases live under
`/tmp/juliet/C/testcases/CWE401_Memory_Leak/` (split into `s01/`, `s02/`, …).

## 2. Ingest into a v2 labeled corpus of buildable projects

```bash
# Full CWE-401:
bun scripts/juliet/ingest.ts --juliet /tmp/juliet/C/testcases/CWE401_Memory_Leak --out demo/juliet_cwe401

# A slice for a dev run:
bun scripts/juliet/ingest.ts --juliet /tmp/juliet/C/testcases/CWE401_Memory_Leak --out demo/juliet_cwe401 --limit 30
bun scripts/juliet/ingest.ts --juliet /tmp/juliet/C/testcases/CWE401_Memory_Leak --out demo/juliet_cwe401 --variant malloc

# Static-only (no support files / Makefile):
bun scripts/juliet/ingest.ts --juliet .../CWE401_Memory_Leak --out demo/juliet_cwe401 --no-build
```

This materializes each testcase into `demo/juliet_cwe401/cases/<id>/` as a
**self-contained, buildable project** and writes a `corpus_manifest.json`
(schema v2). Each case dir contains:
- the testcase source file(s),
- Juliet's support files (`std_testcase.h`, `std_testcase_io.h`, `io.c`, plus
  any header the testcase `#include`s) — auto-located from `testcasesupport/`
  (override with `--support <dir>`),
- a `Makefile` that builds **only the bad path** (`-DINCLUDEMAIN -DOMITGOOD`)
  with AddressSanitizer + LeakSanitizer, outputting `a.out`.

Per-case ground truth: the `..._bad` function is the flaw (positive);
`goodG2B`/`goodB2G` are clean (negatives), taken from Juliet's `_bad` / `good*`
naming convention plus the inline `/* FLAW */` marker (the flaw line). The good
functions stay in the source (so static analysis still scores them as negatives)
but are compiled out, so any LeakSanitizer hit is unambiguously the `_bad` flaw.

> LeakSanitizer reports leaks only on **Linux** — run the dynamic-analyzer in
> Docker (as in the normal dev setup). On macOS `make run` compiles and runs but
> ASan prints "detect_leaks is not supported on this platform".

## 2b. Try a few samples by hand

Each case is a normal project, so your usual workflow works inside it:

```bash
cd demo/juliet_cwe401/cases/CWE401_Memory_Leak__malloc_char_01
make run                              # build + run the bad path (LSan on Linux)
leak-tui scan . --dynamic selective   # your /scan workflow: static + dynamic
```

## 3. Evaluate (all modes)

```bash
# Deterministic baseline (fast, free) — static only:
bun apps/leak-inspector-tui/src/cli.ts eval --corpus demo/juliet_cwe401 --mode no_llm --concurrency 6

# Static + dynamic (LeakSanitizer confirms the leak; needs Linux/Docker build):
bun apps/leak-inspector-tui/src/cli.ts eval --corpus demo/juliet_cwe401 --mode no_llm --dynamic selective --concurrency 4

# Agentic — validate on a slice, then the full set (resumable):
bun apps/leak-inspector-tui/src/cli.ts eval --corpus demo/juliet_cwe401 --mode llm_assisted --dynamic selective --limit 30
bun apps/leak-inspector-tui/src/cli.ts eval --corpus demo/juliet_cwe401 --mode llm_assisted --dynamic selective --resume
```

Or run it **inside the interactive TUI** — opens a live EVAL dashboard (set
`/mode` and `/dynamic` first, they carry over):

```
/mode llm_assisted
/dynamic selective
/eval demo/juliet_cwe401 30 c=4 --resume
#       <corpus>          │  │   └ continue from the per-case cache
#                         │  └ c=N parallel cases (default 3 llm / 6 no_llm)
#                         └ optional limit
```
Cases run in **parallel**; the dashboard has three tabs (Tab/←→ to switch):
**Overview** (live P/R/F1 + confusion, per-variant + ECE on finish), **Cases**
(per-case status + current phase + TP/FP/FN — ↑/↓ to select, Enter for detail),
**Detail** (the case's ground-truth-vs-findings comparison + report link). Esc
exits; `/eval` with no path re-opens the dashboard.

Each run writes thesis artifacts to `results/eval-juliet_cwe401-<mode>-<ts>/`:
`metrics.json`, `metrics.csv`, `rows.csv`, `report.md` (Precision/Recall/F1 +
confusion matrix + per-variant breakdowns), and `tables.tex` (LaTeX). `--resume`
reuses the per-case cache so a long run can be stopped and continued.
