# simple-leak fixture

Minimal single-file smoke-test fixture: `make_buffer()` allocates and returns a
buffer that `main()` never frees. Used only by CI/dev smoke checks
(`scripts/run-local-scan-smoke.ts`, `scripts/tui-store-smoke.ts`) and a couple
of unit tests as a fast, network-free sanity fixture for "does the scan
pipeline detect *a* leak at all".

**Not an evaluation dataset.** It has no thesis-level credibility claim
attached — for evaluation results see `docs/DATASETS.md` (Juliet CWE-401,
LAMeD).
