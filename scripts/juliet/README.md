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

## 2. Ingest into a v2 labeled corpus

```bash
# Full CWE-401:
bun scripts/juliet/ingest.ts --juliet /tmp/juliet/C/testcases/CWE401_Memory_Leak --out demo/juliet_cwe401

# A slice for a dev run:
bun scripts/juliet/ingest.ts --juliet /tmp/juliet/C/testcases/CWE401_Memory_Leak --out demo/juliet_cwe401 --limit 30
bun scripts/juliet/ingest.ts --juliet /tmp/juliet/C/testcases/CWE401_Memory_Leak --out demo/juliet_cwe401 --variant malloc
```

This materializes each testcase into `demo/juliet_cwe401/cases/<id>/` and writes a
`corpus_manifest.json` (schema v2) with per-case ground truth: the `..._bad`
function is the flaw (positive); `goodG2B`/`goodB2G` are clean (negatives).

Ground truth comes from Juliet's naming convention (`_bad` / `good*`) plus the
inline `/* FLAW */` marker (recorded as the flaw line for line-accuracy checks).

## 3. Evaluate (all modes)

```bash
# Deterministic baseline (fast, free) — run the full set:
bun apps/leak-inspector-tui/src/cli.ts eval --corpus demo/juliet_cwe401 --mode no_llm --concurrency 6

# Agentic — validate on a slice, then the full set (resumable):
bun apps/leak-inspector-tui/src/cli.ts eval --corpus demo/juliet_cwe401 --mode llm_assisted --limit 30
bun apps/leak-inspector-tui/src/cli.ts eval --corpus demo/juliet_cwe401 --mode llm_assisted --resume
```

Each run writes thesis artifacts to `results/eval-juliet_cwe401-<mode>-<ts>/`:
`metrics.json`, `metrics.csv`, `rows.csv`, `report.md` (Precision/Recall/F1 +
confusion matrix + per-variant breakdowns), and `tables.tex` (LaTeX). `--resume`
reuses the per-case cache so a long run can be stopped and continued.
