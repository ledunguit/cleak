# Experiment log — 9-baseline Juliet CWE-401 sweep (2026-08-14 → 2026-08-16)

> **Status: COMPLETE.** All 9 baselines (B1–B7, incl. B6a/B6b isolation points)
> finished on the full validated 1658-case Juliet CWE-401 corpus, including two
> targeted redos of contaminated runs (see Timeline items 6 and 8). Written to
> capture the events, bugs, fixes, and raw numbers from this sweep while they're
> fresh, so `conference/main.tex` (§Evaluation, particularly "Capability ablation:
> five orchestration factors" and "Full-corpus result") can be updated from it with
> full context. Numbers below are pulled directly from `metrics.json`/`variance.json`
> /per-case cache JSON via `evaluation/inspect.ts` (see Timeline item 7), not
> transcribed from memory.

## Scope

- **Corpus**: NIST Juliet C/C++ v1.3, CWE-401 (memory leak), full corpus — **1658
  cases** (1480 clean / 178 warned / 0 quarantined at ingest-validate).
- **Sweep**: all 9 declared baselines (`configs/baselines/*.yaml`) — B1, B2, B3,
  B4, B5, B6, B6a, B6b, B7 — run via `evaluation/cli.ts --all-baselines`, each
  fusion-mode baseline (B4–B7) repeated 3× for mean ± std.
- **Model**: `deepseek-v4-flash` (DeepSeek-V4-Flash-0731, reasoning model) via the
  `openai-compat` provider → OpenCode Go gateway
  (`https://opencode.ai/zen/go/v1`). Pricing `$0.14/1M in, $0.28/1M out`.
- **Code commit**: `5eec8b1` (`feat(eval): circuit breaker on consecutive case
  errors`) throughout the WSL2 run — this commit is what should be cited as the
  ingest/eval-tooling provenance for every number below.
- **Environment (final, WSL2)**: Windows 11 host, WSL2 (Ubuntu 22.04, kernel
  `6.6.87.2-microsoft-standard-WSL2`), Ryzen 9, 32 logical cores, **15GB RAM**
  visible to WSL2 (not the host's full 32GB — WSL2 memory cap), NVMe disk. Node
  22.23.2, pnpm 11.18.0, clang 14.0.0, valgrind 3.18.1. Evaluation CLI run at
  `--concurrency 16` throughout (see Timeline item 3).

## Timeline of events

1. **VPS phase (INSECLAB, Kubernetes pod, 128 CPU / 2TB RAM shared host)** — full
   preflight, toolchain install, corpus ingest, and a first sweep attempt.
   - **Bug found and fixed on VPS**: dynamic-only discovery (B2) silently
     produced 0 candidates across the *entire* 1658-case corpus. Root cause: two
     independent "assume Docker" defaults both resolved to the literal path
     `/workspace` — (a) `pathResolver.ts`'s `buildPathResolver` defaults
     `analyzerRoot` to `/workspace` when `hostRoot`/`analyzerRoot` aren't set in
     `cleak config`, and (b) `dynamic-analyzer`'s `path-guard.ts` defaults
     `WORKSPACE_ROOT` to `/workspace` *if that path exists on disk* — and on this
     VPS, `/workspace` coincidentally existed (leftover from the base NVIDIA NGC
     image, unrelated to this project). Every `buildTarget` call was silently
     rejected by the path-guard (`path escapes WORKSPACE_ROOT`) in ~0-2ms,
     masquerading as "ran fine, found nothing." Fix (deployment-only, no code
     change): set `hostRoot`/`analyzerRoot` explicitly in `~/.config/cleak/config.json`
     to the real repo path, and start `dynamic-analyzer` with `WORKSPACE_ROOT`
     set explicitly to the same path. Verified: dynamic-only discovery went from
     0/1658 candidates to a real, non-trivial hit rate after the fix.
   - VPS pod was killed by the cluster (resource reallocation) mid-sweep, after
     B1-B3 complete and B4 ~25% into run 3/3. `/network-volume` (NFS PVC) data
     survived; the pod's ephemeral container layer (including running tmux
     sessions and `~/.config/cleak/config.json`) did not. VPS never came back
     within a reasonable wait window → **abandoned**, moved to a local machine.
2. **Pivot to WSL2** — same repo, same commit, fresh setup:
   - SSH access to WSL2 set up via **Cloudflare Tunnel** (named tunnel,
     `ssh.ledangdung.com` → `ssh://localhost:22`), since both machines are on the
     same home network but the coordinating session runs on a separate Mac.
   - New dedicated ed25519 key (`thesis-wsl2`) generated for this access path.
   - `apt` toolchain install initially failed: a stray
     `/etc/apt/sources.list.d/ubuntu.sources` pinned `Suites: lunar` (Ubuntu
     23.04) from `old-releases.ubuntu.com`, which apt preferred over jammy's own
     `libllvm14`/`libllvm15` (higher version number), pulling in a package that
     requires `glibc >= 2.36` on a jammy (glibc 2.35) system → unsatisfiable
     dependency chain blocking `clang`/`valgrind` install. Fixed by disabling
     that one source file (renamed to `.disabled`, not deleted).
   - `hostRoot`/`analyzerRoot`/`WORKSPACE_ROOT` set explicitly **from the start**
     this time (lesson learned from the VPS bug) — confirmed via a 5-case
     dynamic-only smoke test (3/5 real candidates, no `/workspace` rejection)
     before committing to the full run.
   - Pricing added to `cleak config` for `deepseek-v4-flash`
     (`inputPerMillion: 0.14, outputPerMillion: 0.28`, per DeepSeek's published
     August 2026 flat rate) so `metrics.json`'s `cost.costUsd` is populated
     instead of `n/a`.
3. **Sweep launched** (`--all-baselines --yes`), default `--concurrency` (3).
   - Observed real-world throughput: ~4.8 cases/min for the LLM-assisted B4 —
     while the WSL2 host sat at **load average ~0.0-0.3 on 32 cores** (fully
     idle). The bottleneck is API round-trip latency (~25-30s/case), not local
     compute, so concurrency=3 was leaving ~29 idle cores on the table.
   - **Operator mistake**: killed the running sweep and relaunched with
     `--concurrency 16 --resume --out <dir>` — but the correct flag is
     `--out-dir`, not `--out`. Since `--out` isn't recognized, `outDir` fell back
     to its `results/baseline-sweep-<new-timestamp>` default, so the "resume"
     silently started a **brand-new empty directory** and began re-running
     B1-B3 for real (wasted ~20 min wall-clock, **zero $ cost** since B1-B3 are
     `no_llm`) and was about to re-run B4 from scratch (which *would* have
     double-spent real LLM cost). Caught before B4 started in the wrong
     directory (`find` showed only `B1/B2/B3` subdirs, no `B4`) — killed,
     archived the empty wrong directory, relaunched with the corrected
     `--out-dir` flag pointed at the original directory. `--resume` then
     correctly resolved B1/B2/B3 from cache (near-instant, numbers matched the
     original run exactly) and continued B4 from its true progress.
   - **Concurrency=16 result**: throughput went from ~4.8 → **~22-27
     cases/min**, a ~4.5-5.5× speedup, in line with the ~5.3× theoretical
     ceiling (16/3). No provider-side rate-limiting observed (no 429s, circuit
     breaker never tripped) at this concurrency against the OpenCode
     Go/DeepSeek gateway.
   - **Circuit breaker** (`maxConsecutiveErrors`, added earlier this session in
     commit `5eec8b1`) never fired during the whole WSL2 run — 0 consecutive
     LLM-call failures observed at any point.
4. **OpenCode Go weekly usage quota exhausted mid-sweep** (`HTTP 429
   GoUsageLimitError: "Weekly usage limit reached. Resets in 1 day."`), after
   ~109M tokens (B4+B5+B6+B6a complete). The sweep's `try/catch` per baseline
   caught this gracefully — B6b and B7 were marked `error` in that run's
   `baseline-sweep.md`, no crash, no corrupted state. The operator rotated the
   API key (new key, fresh quota); verified with a direct HTTP 200 probe against
   `https://opencode.ai/zen/go/v1/chat/completions` before resuming.
5. **WSL2 rebooted overnight** (Windows sleep/hibernate cycle) between the
   quota-exhaustion pause and the next-day resume — `uptime` showed ~3 minutes
   on reconnect. WSL2's *filesystem* is persistent (local disk: all
   config/results/cache survived intact), but its *running processes* (tmux
   server, the static/dynamic-analyzer node processes) do **not** survive a
   WSL2 instance restart, unlike a long-lived VM. Fix: restarted
   `static-analyzer` (`STATIC_PARSER_WORKERS=8`) and `dynamic-analyzer`
   (`WORKSPACE_ROOT=/root/Thesis/cleak`) in fresh tmux sessions before resuming;
   this recurred a second time later in the sweep and was handled the same way
   both times — **lesson for any future long WSL2 run: assume a reboot can
   happen at any point and script the two-service restart, don't rely on
   uptime**.
6. **B6b/run-2 contamination discovered and fixed.** After resume, B6b's 3 runs
   completed, but run-2's F1 (0.7025) was a clear outlier against run-1 (0.855)
   and run-3 (~0.878). Root-caused (via `judgePathCounts` — the per-case tally of
   which judge path, `llm` vs `heuristic`, actually decided each verdict) to a
   **silent LLM-judge-failure → heuristic-fallback** mechanism that is
   *architectural by design*, not a bug: `llmJudge.ts`'s `judgeBundleWithLlm`
   returns `null` (not throw) on any model-call/parse failure, and the caller
   silently keeps the case's pre-assigned heuristic verdict. This means a run
   can look completely healthy at the case level (every case `status: ok`, zero
   errors surfaced anywhere) while a large fraction of its LLM judgments have
   silently degraded to the heuristic baseline — the *only* visible symptom is a
   depressed `llm`-path share in `judgePathCounts`, which nothing in the harness
   warns about except the all-or-nothing "0 LLM verdicts in the whole run"
   check (a *partial* degradation like this produces no warning anywhere).
   Comparing run-1/run-3 (healthy, ~42–44% of verdicts via `llm`) against run-2
   (~9% via `llm`) confirmed provider instability in the window right before the
   quota wall (item 4) had silently degraded most of run-2's judgments. **Fix
   applied**: cleared only `B6b/run-2/cases/*.json` (kept run-1/run-3's
   legitimate cached data) and re-ran `--baseline B6b --resume`, which
   cache-skipped the two healthy runs and redid only run-2 for real —
   confirmed clean afterward (`llm%` 42.2%, matching run-1/run-3).
7. **New tooling: `evaluation/inspect.ts` + a `$` cost column.** Checking a
   sweep's health/progress by hand (SSH in, ad hoc `node -e` scripts over
   `cases/*.json`, repeated dozens of times across this sweep) motivated a
   proper read-only inspector, added to the codebase: `evaluation/inspect.ts` +
   `evaluation/inspectSweep.ts` render the exact `baseline-sweep.md` table for
   every baseline that has finished, and a live per-run progress line (case
   count, status breakdown, judge `llm`/`heuristic` ratio, running FP/KLOC) for
   whichever baseline is still mid-run — safe to point at a directory another
   process is actively writing to. While using it, we also noticed the
   sweep-comparison table (`baselineSweep.ts`, shared by
   `scripts/run-baselines.ts`, `evaluation/baselines.ts`, and the new inspector)
   had never surfaced the already-computed `EvalResult.cost.costUsd` — a real
   gap for a system whose evaluation explicitly frames cost as a first-class
   axis (`docs/ABLATION-PLAN.md`'s "chi phí ↔ lợi ích" framing). Added a `$
   cost` column to all three renderers (Markdown/CSV/LaTeX), populated from the
   already-configured DeepSeek pricing, with the `undefined` (unpriced model) ≠
   `$0` (genuinely free) distinction preserved throughout. 8 new unit tests;
   all 36 existing `evaluation/` tests and 6 `baselineSweep` renderer tests
   still pass.
8. **B7/run-3 contamination discovered and fixed — same root cause, second
   occurrence.** Using the new `inspect.ts` tool immediately surfaced the same
   silent-fallback pattern in B7's first completed 3-run sweep: run-1 (42.4%
   `llm`) and run-2 (42.8%) were healthy, but run-3's `llm` share degraded
   *within the run itself* (40.6% in its first half → 22.7% in its second half,
   confirmed by sorting cache files by mtime), landing at an aggregate 27.1%
   with `fpPerKloc` more than 3× the healthy runs' (0.596 vs ~0.19–0.20) — no
   errors surfaced anywhere, every case still `status: ok`. Applied the exact
   same fix as item 6: cleared `B7/run-3/cases/*.json` only, re-ran `--baseline
   B7 --resume` (cache-skipped run-1/run-2, redid run-3 for real). Confirmed
   clean: **43.6% `llm`**, matching run-1/run-2. This is now a **confirmed
   recurring operational risk**, not a one-off: two independent baselines
   (B6b, B7) both had exactly one of their three runs silently contaminated by
   the same provider-instability-to-heuristic-fallback mechanism, both times
   invisible except via `judgePathCounts`. **Recommendation for future sweeps**:
   always spot-check per-run `judgePathCounts` ratios against each other before
   trusting a multi-run mean — a run whose `llm%` diverges sharply from its
   siblings (even with zero visible errors) should be treated as suspect and
   redone, exactly as `variance.json`'s `f1.std` would have hinted anyway (both
   contaminated runs produced an outlier F1 that inflated the reported std by
   an order of magnitude before the redo).

## Naming note: B7 is "Full adaptive," not "Proposed"

B7 (`configs/baselines/b7-full-adaptive.yaml`, formerly `b7-proposed.yaml`) is
just the ablation point with every axis on — it isn't automatically the thesis's
recommended architecture. Results below show B6a matching or exceeding
B7-shaped configurations on F1 (see Finding 6), so labeling it "Proposed"
pre-judged the comparison this sweep exists to make. Renamed throughout
`configs/`, `docs/`, `evaluation/README.md`, and the relevant test fixture —
`conference/main.tex` and `paper/chapters/*.md` already used "Full adaptive" and
needed no change. Historical generated `results/**/baseline-sweep.*` artifacts
from past runs were left as-is (they reflect what the config actually said at
the time each ran).

## Results — FINAL (full corpus, n=1658, all 9 baselines complete)

All confusion-matrix cells, rates, and costs below are read directly via
`evaluation/inspect.ts results/baseline-sweep-2026-08-15T08-28-06` (which itself
reads `metrics.json`/`variance.json`, or live-aggregates `cases/*.json` for
anything not yet finalized — nothing was; every row below is a `final` row).
**B6b and B7 are the POST-REDO, corrected numbers** (see Timeline items 6 and 8).

| ID | Baseline | TP | FP | FN | TN | Precision | Recall | **F1** | FP/KLOC | ECE | MCP/case | tok/case | $ cost |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| B1 | Static only | 1433 | 674 | 1145 | 2785 | 68.0% | 55.6% | 0.612 | 1.241 | 0.328 | 1 | 0 | — |
| B2 | Dynamic only | 735 | 0 | 2283 | 0 | 100.0% | 24.4% | 0.392 | 0.000 | 0.034 | 2 | 0 | — |
| B3 | Rule-based ensemble | 1686 | 674 | 892 | 2785 | 71.4% | 65.4% | 0.683 | 1.241 | 0.087 | 3 | 0 | — |
| B4 | LLM + static | 2035 | 470 | 543 | 2989 | 81.2% | 78.9% | 0.801 ± 0.001 | 0.865 | 0.083 | 8 | 9947 | $9.69 |
| B5 | LLM + dynamic | 735 | 0 | 2282 | 0 | 100.0% | 24.4% | 0.392 ± 0.005 | 0.000 | 0.003 | 2 | 303 | $0.26 |
| B6 | LLM + all (no planner/sel) | 2009 | 74 | 569 | 3390 | 96.4% | 77.9% | 0.862 ± 0.001 | 0.136 | 0.110 | 10 | 5513 | $5.99 |
| **B6a** | **+ planner only** | **2010** | **72** | **568** | **3392** | **96.5%** | **78.0%** | **0.863 ± 0.001** | **0.133** | 0.109 | 10 | 6155 | $6.63 |
| B6b | + tool_selector only | 2017 | 104 | 561 | 3360 | 95.1% | 78.2% | 0.858 ± 0.003 | 0.192 | 0.157 | 15 | 30590 | $26.07 |
| B7 | Full adaptive | 2004 | 101 | 574 | 3363 | 95.2% | 77.7% | 0.856 ± 0.002 | 0.186 | 0.156 | 15 | 32004 | $27.14 |

**F1 ranking: B6a (0.863) ≈ B6 (0.862) > B6b (0.858) ≈ B7 (0.856) > B4 (0.801) >
B3 (0.683) > B1 (0.612) > B5 ≈ B2 (~0.392).** Std across the 3 repeats is small
throughout **after** the two redos (0.001–0.005) — the model/pipeline is stable
run-to-run at the aggregate level once contaminated runs are excluded.

**Sweep total LLM cost: $75.78** (B4 $9.69 + B5 $0.26 + B6 $5.99 + B6a $6.63 +
B6b $26.07 + B7 $27.14; B1–B3 are `no_llm`, unpriced/$0). Including the sunk
cost of the two contaminated pre-redo runs (B6b/run-2 ≈ $8–9 estimated pro-rata,
B7/run-3 $23.89 measured before redo), **total real spend across the whole
sweep (incl. redos) ≈ $96–108**.

### Cost breakdown (B4/B5 — see Finding 1 for the mechanism)

| Baseline/run | input tokens | output tokens | cost |
|---|--:|--:|--:|
| B4/run-1 | 15,992,991 | 8,537,896 | $4.630 |
| B4/run-2 | 7,280,715 | 5,765,749 | $2.634 |
| B4/run-3 | 6,465,938 | 5,434,971 | $2.427 |
| **B4 total** | | | **$9.69** |
| B5/run-1 | 420,838 | 123,390 | $0.093 |
| B5/run-2 | 382,779 | 99,249 | $0.081 |
| B5/run-3 | 378,782 | 100,460 | $0.081 |
| **B5 total** | | | **$0.26** |

Note B4/run-1's token cost (~$4.63) is nearly double run-2/run-3 (~$2.4-2.6) for
the *identical* config — see Finding 3 ("LLM run-to-run token variance"); this
is not a bug, confirmed by direct same-case-ID comparison across runs.

## Key findings for the evaluation narrative

1. **B4 (LLM+static) vs B5 (LLM+dynamic): LLM fusion value is conditional on
   discovery richness.** B1→B4 (static-only base, then LLM fusion added) jumps
   F1 0.612→0.801 (+0.189). B2→B5 (dynamic-only base, then LLM fusion added)
   moves F1 0.392→~0.392 (statistically flat). Interpretation: dynamic-only
   candidates are synthesized with hardcoded `confidence: 'high'`
   (`dynamicDiscovery.ts` — a leak *observed* at runtime is about as strong a
   discovery signal as exists), so the heuristic judge is already maximally
   confident on them and rarely escalates to the LLM — the LLM mostly just
   re-confirms verdicts the heuristic already had right. LLM reasoning has much
   more *room to add value* over the noisier, larger candidate set static
   discovery produces (B1's 68%P/56%R base) than over dynamic's
   already-clean-but-sparse 100%P/24%R base.

   **This is a two-factor effect, not one — quantified directly from
   `judgePathCounts` + per-case token/MCP data (B4/run-1 vs B5/run-1):**

   | | B4 (LLM+static) | B5 (LLM+dynamic) |
   |---|---|---|
   | cases escalated to `llm` | 895/1658 (54%) | 234/1658 (14%) |
   | mean tokens/case, escalated | 15,812 | 1,712 (~9× less) |
   | mean tokens/case, heuristic-only | 13,604 | 101 |
   | mean MCP calls/case, escalated | 8.33 | 2.00 (identical to heuristic-only) |

   Factor A: dynamic's `confidence: 'high'` candidates trip the borderline
   threshold far less often (14% vs 54%). Factor B — the sharper one: *even
   when escalated*, B5's LLM call does no extra investigation at all (2.00 MCP
   calls/case, exactly matching the heuristic-only path's fixed
   discovery-recipe overhead) — it's a single confirm/deny judgment over one
   unambiguous runtime-observed candidate, not an agentic investigation. B4's
   escalated cases average 8.33 MCP calls because static's noisier,
   multi-candidate signal genuinely requires the agent to explore/compare
   before judging. Together these two factors compound into B5's total 3-run
   cost ($0.26) being ~2.7% of B4's ($9.69) for the same fusion architecture.
2. **B6 (LLM+all, no planner/selector) already exceeds B4 alone**: F1 0.862 ±
   0.001 (3-run mean) vs B4's 0.801 ± 0.001 — combining static+dynamic
   discovery *and* LLM fusion stacks the static gains with dynamic's zero-FP
   property (B6: fp=74, much lower than B4's 470), i.e. dynamic evidence is
   contributing precision even though it's LLM-inert on its own (finding 1) —
   it disambiguates/confirms static's flagged sites rather than surfacing new
   ones. This is the clearest evidence yet that static+dynamic fusion (not
   either alone) is what the LLM orchestrator should be spending its
   evidence-gathering budget on.
3. **B4's run-to-run token variance (run-1 ~2× run-2/run-3) is real, not a
   double-counting bug** — verified by comparing token counts for the *same case
   ID* across runs directly (not just aggregate totals), and by checking the
   in-run token distribution for monotonic-growth artifacts (found none — a
   healthy p50/p90/p99/max spread). Leading hypothesis: `deepseek-v4-flash` is a
   reasoning model: reasoning-chain length (and thus agentic tool-calling turn
   count) is not fully deterministic run-to-run even at `temperature=0`, for many
   providers' MoE serving stacks. This is exactly the variance `runs=3` (rather
   than 1) is designed to average out for B4-B7.
4. **Throughput is API-latency-bound, not compute-bound, on modern hardware.**
   With 32 idle cores and 15GB free RAM (WSL2), `--concurrency 3` (the
   evaluation CLI's default) achieved only ~4.8 case/min; `--concurrency 16`
   achieved ~22-27/min (~4.5-5.5×) with zero provider-side rate-limit errors.
   Worth a methods-section footnote: default concurrency is conservative for
   small/shared hosts, but under-utilizes a dedicated modern workstation by
   roughly 5×.
5. **The circuit breaker (this session's own contribution, commit `5eec8b1`)
   never had to fire** across the entire sweep — a true negative, not evidence
   it doesn't work (it was unit-tested in isolation; see
   `apps/leak-inspector-tui/tests/domain/evalHarness.test.ts`), but confirms no
   *consecutive* per-case failure streaks occurred even though the underlying
   provider *did* degrade silently within individual runs (Findings 6 and 8) —
   the circuit breaker and the `judgePathCounts` integrity signal catch two
   different failure modes (hard consecutive errors vs. silent per-case
   judge-quality degradation) and neither substitutes for the other.
6. **B6a (+ planner) is statistically indistinguishable from B6** (F1 0.863 ±
   0.001 vs 0.862 ± 0.001 — within each other's std). On Juliet CWE-401
   specifically, the LLM strategist/planner axis adds essentially nothing once
   static+dynamic fusion is already active — plausibly because Juliet's
   single-function, single-file cases don't have enough project-level
   structure for a planning stage to meaningfully redirect evidence-gathering.
   This is a corpus-shape caveat worth stating explicitly if B6a's numbers are
   cited: the planner's value proposition may only show up on larger, more
   structurally varied real-project corpora (LAMeD/MemHint), not on Juliet.
7. **Agentic tool-selection (B6b) and the full-adaptive config (B7) do not
   improve on the deterministic-recipe configs (B6/B6a) — and cost far more.**
   B6b (F1 0.858, $26.07) and B7 (F1 0.856, $27.14) both sit *below* B6a (F1
   0.863, $6.63) despite spending ~4× the tokens and ~4× the dollar cost
   (30–32K tok/case vs ~6K tok/case). This mirrors the earlier n=50-stratified
   finding on a different model (`mimo/mimo-v2.5-pro`) and now replicates on
   the full 1658-case corpus on a different model (`deepseek-v4-flash`) —
   giving the LLM latitude over *which* tool to call next, rather than a fixed
   deterministic recipe, adds cost without adding accuracy on Juliet. The
   FP/KLOC also degrades slightly under agentic selection (B6b 0.192, B7 0.186
   vs B6a's 0.133) — more tool calls means more opportunities for the agent to
   surface a borderline finding the fixed recipe wouldn't have investigated.
8. **Silent LLM-judge-fallback is a confirmed, recurring operational risk for
   any multi-run LLM-assisted sweep, not a one-off anomaly.** Two independent
   baselines (B6b/run-2, B7/run-3 — see Timeline items 6 and 8) both had
   exactly one of three repeat runs silently degrade to a much higher
   heuristic-judge share (down to ~9% and ~27% `llm`, vs a healthy ~42–44%)
   with **zero visible errors** at any level (every case `status: ok`, no
   exceptions, no circuit-breaker trips) — because `llmJudge.ts`'s
   `judgeBundleWithLlm` returns `null` rather than throwing on a model-call or
   parse failure, and the caller silently falls back to the pre-computed
   heuristic verdict by design. This is methodologically important: an
   aggregate `f1.std` across runs can look like "normal LLM variance" when it
   is actually one contaminated run inflating the spread by an order of
   magnitude (pre-redo B7: std 0.023; post-redo: std 0.002). **Recommendation,
   now validated twice**: report `judgePathCounts`/`judgePathDistribution`
   alongside every multi-run mean±std, and treat a run whose `llm`-share
   diverges sharply from its sibling runs as suspect regardless of whether any
   case-level error was ever raised.

## Open items / not yet in this log

- No LAMeD run yet on WSL2 (was planned as a parallel run on a second
  static/dynamic-analyzer pair on alternate ports; deferred while VPS access was
  being debugged, not yet resumed here).
- `docs/EVALUATION.md`'s existing §3b headline table is the **n=50 stratified**
  sample on `mimo/mimo-v2.5-pro` — historical, kept as-is (family-balanced
  ablation on a different, smaller sample/model). This sweep is a *new*,
  separate full-corpus (n=1658, all 9 baselines, 3-run variance, real $ cost) on
  `deepseek-v4-flash` — added as a new subsection, not merged into the old one
  (see `docs/EVALUATION.md` §3b-bis).
- `conference/main.tex`'s current full-corpus table (`tab:progression`,
  §Full-corpus result) explicitly caveats that it has **no dynamic stage**; this
  sweep is now the first full-corpus (n=1658) measurement WITH dynamic evidence
  included, across all 9 capability configurations — see the separate main.tex
  edit plan for how this supersedes that caveat.
