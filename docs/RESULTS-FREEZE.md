# Results freeze — single source of truth

> Every number quoted in the thesis chapters, appendix, slides, and Q&A bank must
> come from this table. One row = one experiment group: name, commit, corpus hash,
> model, date, results path, headline numbers. After this freeze no new
> experiment enters the thesis except the MemHint run (row 10) and nothing else.
> Corpus hashes come from the corpus lockfiles (`demo/juliet_cwe401.lock.json`,
> `demo/lamed.lock.json`, `demo/memhint.lock.json`) and are re-recorded in each
> artifact's own provenance block; they agree everywhere both exist.

**Corpus hashes (from lockfiles):**

| corpus | contentHash | cases |
|---|---|--:|
| Juliet CWE-401 (`demo/juliet_cwe401.lock.json`) | `f578c3ee228c1ae06095c7c850e44944` | 1658 |
| LAMeD (`demo/lamed.lock.json`) | `bf728e94c821b34b7c6b76dd8b2532ca` | 41 |
| MemHint (`demo/memhint.lock.json`) | see row 10 | 19 |

## The freeze table

| # | Experiment | Commit | Corpus hash | Model | Date | Results path | Headline numbers |
|--:|---|---|---|---|---|---|---|
| 1 | Juliet full 9-baseline sweep (B1–B7, 1658 cases, deepseek-v4-flash, B4–B7 ×3 runs). Table source: docs/EVALUATION.md §3b-bis (has F1 and $ only, no MCC column — MCC below comes from B6a/variance.json) | `5eec8b1` | `f578c3ee` | deepseek-v4-flash (openai-compat) | 2026-08-15/16 | `results/baseline-sweep-2026-08-15T08-28-06/` | **B6a P 0.965 / R 0.780 / F1 0.863±0.001 / MCC 0.790 / $6.63** (2010/72/568/3392; MCC = 3-run mean from B6a/variance.json, per-run 0.792/0.789/0.788). Full ranking: B6a 0.863 ≈ B6 0.862 > B6b 0.858 ≈ B7 0.856 > B4 0.801 > B3 0.683 > B1 0.612 > B5 0.392 ≈ B2 0.392. B7 agentic $27.14 (~4× B6a for lower F1). Sweep total $75.78 |
| 2 | Juliet no_llm full-corpus, postfix4 generation (cross-checks B1 row of group 1: same commit-lineage numbers, 1433/674/1145/2785) | `c07bee5` | `f578c3ee` | — (no_llm, heuristic judge) | 2026-08-12 | `results/eval-no_llm-juliet-full-postfix4/` | P 68.0% / R 55.6% / F1 0.612 / MCC 0.375 (report.md:29-35). Do not substitute the older postfix3 precision/recall pair |
| 3 | Juliet llm_assisted full-corpus, 2026-08-11. **Older commit generation than group 1 (predates the 2026-08-12 reference-out-param/virtual-dispatch/RAII fix chain): used for cost and judge-path data ONLY, not for cross-config F1 comparisons** | `9db30f0` | `f578c3ee` | oc/deepseek-v4-flash-free | 2026-08-11 | `results/eval-llm_assisted-juliet-full/` | F1 0.776 (P 0.779 / R 0.773 / MCC 0.610), $12.66, judge path on flagged verdicts: heuristic 1826 (66.4%) / llm 923 (33.6%) |
| 4 | LAMeD 2026-08-20 four-run set on the corrected 50-site denominator (real-project corpus, 41 cases / 7 projects; narrative: results/lamed-correction-2026-08-20-README.md). Positive-only scoring: recall + FP count | `c5826bc` | `bf728e94` | deepseek-v4-flash (LLM run; the other three need no model) | 2026-08-20 | `results/lamed-llm_assisted-2026-08-20/` + `results/lamed-no_llm-default-2026-08-20/` + `results/lamed-no_llm-ipf-2026-08-20/` + `results/lamed-baseline-2026-08-20/` | **llm_assisted (3 runs): TP15/FP0/FN35, R 30.0%, std=0** — identical to no_llm (LLM judge invoked 47–149×/run, never flipped a verdict). no_llm default and no_llm +interproceduralFlow: byte-identical, TP15/FP0/FN35, R 30.0% (interproceduralFlow Δ=0). Clang SA baseline: 43 sites, TP0/FN43 (site counts not on a shared denominator, by scorer design) |
| 5 | Consensus ablation, n=50 stratified (2×2 runs), deepseek-v4-flash. Reversed result: single-LLM beats consensus | `f0d371c` | `f578c3ee` | deepseek-v4-flash | 2026-08-19 | `results/consensus-ablation-n50-2026-08-19/` (+ `.log`) | single flip 2.0% / F1 0.852 vs K=3 flip 8.0% / F1 0.793; McNemar 205 paired sites, χ²=3.13, p=0.077 (lean single, NOT significant). Consensus not recommended as default |
| 6 | Allocator-profile validation, full LAMeD corpus (7 projects), deepseek-v4-flash temp 0 | (not recorded in log) | (lamed corpus; lockfile above) | deepseek-v4-flash | 2026-08-19 | `results/allocator-profile-validation-2026-08-19.log` (+ `-README.md`) | cJSON (paper-cited scope): allocators P35%/R92% F1 0.51, deallocators P67%/R100% F1 0.80 — paper's claim corroborated. Aggregate across all 7 projects: allocators P24%/R21% F1 0.22, deallocators P16%/R19% F1 0.17 (raw per-project detail in the .log) |
| 7 | Stratified 9-baseline sweep (§3b), n=50 stratified round-robin over 10 functional families, 3 runs for LLM rows. Artifact: `results/ds5-juliet-50/` (9-row table matches docs/EVALUATION.md §3b exactly) | `b5541ec` | `f578c3ee` | mimo/mimo-v2.5-pro | 2026-06-29 (re-measured on validated corpus `f578c3ee`) | `results/ds5-juliet-50/` | B6a P 0.973 / R 0.906 / F1 0.938±0.015 (48/1/5/156). Family variance (B6a, full-corpus sweep group 1, per-run byFunctionalVariant across its 3 runs): **malloc F1 0.991 → strdup F1 0.584** — the sampling-methodology gap behind stratified-vs-full divergence |
| 8 | B6a-mimo sweep (full 1658 corpus, second-model evidence for B6a) | `03efc76` | `f578c3ee` | mimo-v2.5 | 2026-08-17 | `results/baseline-sweep-B6a-mimo-2026-08-17T16-52-13/` (supersedes the incomplete 16-44-57 dir) | F1 0.737 (P 0.880 / R 0.633 / MCC 0.611), 1633/222/946/3251, $2.11 |
| 9 | B6a-zai sweep (full 1658 corpus, third-model evidence for B6a) | (not recorded in run artifacts) | `f578c3ee` | glm-5.2 (z-ai) | 2026-08-19 | `results/baseline-sweep-B6a-zai-2026-08-19T04-25-01/` (+ `.log`) | Run 1 of 2 complete: F1 0.774 derived from 1658 per-case rows (P 0.763 / R 0.786; raw counts tp 2028 / fp 631 / fn 551 / tn 2842). Run 2 partial (25/1658), excluded. No cost figure: the sweep wrote no priced aggregate |
| 10 | MemHint corpus (19 cases / 6 real projects): no_llm --enrich ×1 + llm_assisted ×3, via scripts/memhint-eval-driver.sh on thesis-wsl2 | `30e04cb1c` | `442de35d6410bdd03d30b665b5f0f912` (lockfile re-written by the driver at re-validation 2026-09-05) | deepseek-v4-flash (openai-compat @ api.deepseek.com, temp 0; the no_llm run needs no model) | 2026-09-05 (run completed on driver attempt 3 of 8 — attempt 1 was lost to a VM reboot mid-run and recovered via the driver's `--resume` design; artifacts sha256-verified byte-identical across the reboot) | `results/memhint-no_llm-2026-08-28/` + `results/memhint-llm_assisted-2026-08-28/` (wsl2, synced) | **no_llm: TP12/FP0/FN14, R 46.2% (12/26 sites). llm_assisted ×3: identical confusion matrix all runs — P 1.000±0.000 / R 0.462±0.000 / F1 0.632±0.000 (std=0; per-run identity set {(12,0,14)}). Heuristic judge decided ~17.1k flagged verdicts per run; the LLM judge fired on only 2 sites in ONE of 3 runs (run 2: 2 flagged verdicts in freerdp_9fc23ad2, judge paths {heuristic:17154, llm:2}; runs 1/3: {heuristic:...} only) — nothing borderline enough to move the confusion matrix, so llm_assisted ≡ no_llm on this corpus by hybrid-judge design. Anchor reconciliation vs the 08-28 partial anchor R 42.3% (11/26, 8 cases OOM-lost): +1 TP from the recovered cases (CURRENT_STATUS.md §Pending #2). Cost ≈44.3M tokens across the 3 llm runs (in ≈26.5M / out ≈17.8M)** |

## Reading rules

- **RQ1 comparisons must stay within group 1** (same sweep, same commit
  `5eec8b1`): B6a 0.863 vs B1 0.612. Never pair 0.776 (group 3, older
  generation) against 0.612.
- **Consensus is a negative result** (group 5): report the reversal and the
  McNemar CI framing, not a win.
- **Positive-only corpora** (LAMeD, MemHint): recall + FP count are the
  comparable metrics; precision/specificity/MCC are not defined (TN=0 by
  construction). See docs/BASELINE-COMPARISON.md.
- **Cost columns across different providers are not comparable** (group 9's $
  is priced at deepseek reference rates). Within-group, same-provider costs
  (groups 1, 3, 8) are.
- The two sweeps in groups 1 and 7 answer different questions: whole-corpus
  performance vs family-balanced component ablation. The reconciliation
  paragraph (stratified 0.938 vs full 0.863) belongs to chapter 4 §4.2 and
  cites both rows plus the family-variance numbers.
- Exploratory sweeps run after this freeze (wave 1) are OUTSIDE this freeze
  and must never be quoted in thesis material.

## Amendment 2026-09-21 (review-remediation)

> Append-only record of numbers added to the thesis chapters by the
> review-remediation plan (`.omo/plans/review-remediation.md`, todos 7-10, 13).
> All values below are copied verbatim from the chapter text of 2026-09-21 and
> trace back to pre-existing frozen artifacts; no new experiment was run and no
> existing freeze row changed.

1. **§4.2.2 CI column (Bảng 4.1).** F1 95% confidence intervals for all 9
   baselines, site-level percentile bootstrap over per-site samples
   (n≈6,042), 1,000 resamples, seed `0xc0ffee`. Multi-run configs are
   run-1-pinned by convention (`results/baseline-sweep-2026-08-15T08-28-06/*/run-1/metrics.json`
   key `overallCI`; single-run B1/B2/B3 from their own `metrics.json`).
   Disclosed exception: B6b CI point 0.855 [0.844, 0.865] sits ~0.003 below the
   printed 3-run mean 0.858 ± 0.003 (within one run-to-run std), footnoted in
   the chapter. Evidence: `.omo/evidence/review-remediation/task-7/ci-extracted.txt`.
2. **§4.2.2 McNemar block (Bảng 4.2).** B6a vs B1: b01=51, b10=1236, n=6037,
   χ²=1089.2432, p=7.192e-239 (significant, B6a better). B6 vs B6a: b01=73,
   b10=66, n=6042, χ²=0.2590, p=0.611 (not significant), and B6a is retained as
   the production configuration for operational reasons (planner provides
   planner-status/coverage for dynamic fallback), not for F1. Both tests
   run-1-pinned, siteId pairing, Edwards continuity correction, via
   `scripts/mcnemar-compare.ts`. Evidence: `.omo/evidence/review-remediation/task-8/`.
3. **§4.2.2 B2/B5 precision cells (Bảng 4.1).** Printed as "—*" instead of
   1.000: precision is undefined for the dynamic-only rows because their
   scoring space contains no negative sites (TN=0), per the fairness rule the
   chapter cites (§4.1.5). Row-total drift across configs (n 6,037 vs 6,042;
   positive space 2,578 vs 3,018) is real artifact variation, footnoted, not
   corrected. Source: `scripts/table-audit.ts` /
   `.omo/evidence/review-remediation/task-9/audit.csv`.
4. **§4.2.6 threshold sweep (Bảng 4.5).** Offline confidence re-thresholding
   over persisted verdicts of the frozen sweep (flag(c) = isFlagged(verdict) ∧
   confidence ≥ c, c ∈ 0.0-1.0 step 0.1, rescored with the production scorer),
   NOT a sweep of the heuristic judge's internal score cutoffs 0.7/0.4 (raw
   signal scores are not persisted; that remains future work). At c=0.0 the
   transform is a no-op and reproduces the stored metrics exactly
   (B1 0.612, B6a 0.864, B6 0.862, deviation 0). Source:
   `paper/figures/threshold-sweep.csv`,
   `.omo/evidence/review-remediation/task-10/` (c=0.0 self-test PASSED).
5. **§4.11 operational-cost fragments (Bảng 4.16).** Assembled only from
   numbers already printed elsewhere (AST cache 54s→3.0s / 1.03GB→266MB;
   dynamic 0.5-1 day per config; judge calls 47-149 per LAMeD run; $/config
   from Bảng 4.1). No new measurement; nothing to add to the freeze rows.
