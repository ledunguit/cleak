/**
 * Todo 5 — offline re-score of EVERY frozen sweep target on the fixed labeled
 * universe (plan decision D1-refined / D2 / D5). ZERO LLM/API calls; the only
 * external tool is the pre-authorized local Clang SA leg (D5).
 *
 *   tsx scripts/rescore-universe.ts            (from the repo root)
 *
 * Reads (read-only):
 *   - demo/juliet_cwe401/corpus_manifest.json           (labels)
 *   - .omo/evidence/scoring-universe-refactor/universe-census.json (merged census — asserted)
 *   - results/baseline-sweep-2026-08-15T08-28-06/**     (9-config sweep)
 *   - results/consensus-ablation-n50-2026-08-19/{s1a,s1b,sca,scb}
 *   - results/baseline-sweep-B6a-mimo-2026-08-17T16-52-13/B6a (flat)
 *   - results/baseline-sweep-B6a-zai-2026-08-19T04-25-01/B6a/run-1 (run-2 partial: EXCLUDED)
 *   - results/eval-juliet_cwe401-llm_assisted-2026-06-17T13-33-20 (stable-by-luck survivor)
 *   - results/ds5-juliet-50 (all configs) and results/ds5-3d-* (the B1 tool-ablation dirs)
 *   - results/lamed-*  results/memhint-*                (verify-only, drift-checked)
 * Writes ONLY: results/rescore-universe-<ts>/ + prints the summary table.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { accumulate, computeMetrics, mcnemar, type Sample } from '../packages/common/src/analysis/metrics';
import {
  buildCaseUniverse,
  buildUniverseAccounting,
  scoreCaseUniverse,
  type MergedLabelSite,
  type SnapshotFinding,
  type UniverseCaseResult,
  isFlagged,
} from '../apps/leak-inspector-tui/src/domain/evalScoring';
import { ClangAnalyzerAdapter } from '../apps/leak-inspector-tui/src/domain/baselines/clangAnalyzer';

// Resolve the repo root from this script's own path (ESM-safe; no __dirname).
const ROOT = join(dirname(resolve(process.argv[1] ?? '')), '..');
const CENSUS = join(ROOT, '.omo/evidence/scoring-universe-refactor/universe-census.json');
const JULIET = join(ROOT, 'demo/juliet_cwe401');
const SWEEP = join(ROOT, 'results/baseline-sweep-2026-08-15T08-28-06');
const OUT = join(ROOT, `results/rescore-universe-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);

const summaryLines: string[] = [];
const logLines: string[] = [];
const log = (s: string) => { logLines.push(s); console.log(s); };
const logErr = (s: string) => { logLines.push(s); console.error(s); };
let escalate = false;

// ── frozen-input helpers ─────────────────────────────────────────────────────

interface Overall { tp: number; fp: number; fn: number; tn: number; total: number }
interface CachedCaseFile {
  id: string;
  samples: Sample[];
  row: { id: string; status: string; tp: number; fp: number; fn: number; tn: number };
  findings: SnapshotFinding[];
}

interface CaseUniverse { caseId: string; sites: { bad: MergedLabelSite[]; good: MergedLabelSite[] }; rawBad: number; rawGood: number }

interface ManifestCase { id: string; repo_path?: string; flaws?: Array<{ function: string }>; clean?: Array<{ function: string }> }

/** Juliet universes, reconstructed from the manifest and ASSERTED against the
 * census (the authoritative artifact) for every case + the corpus totals. */
function loadJulietUniverses(): Map<string, CaseUniverse> {
  const manifest = JSON.parse(readFileSync(join(JULIET, 'corpus_manifest.json'), 'utf-8')) as { cases: ManifestCase[] };
  const census = JSON.parse(readFileSync(CENSUS, 'utf-8')) as {
    merged: { bad: number; good: number; total: number };
    perCaseSites: Record<string, { bad: string[]; good: string[] }>;
  };
  const map = new Map<string, CaseUniverse>();
  let bad = 0;
  let good = 0;
  for (const c of manifest.cases) {
    const rawBad = (c.flaws ?? []).map((f) => f.function);
    const rawGood = (c.clean ?? []).map((f) => f.function);
    const sites = buildCaseUniverse({ bad: rawBad, good: rawGood });
    const expected = census.perCaseSites[c.id];
    if (!expected) throw new Error(`census has no per-case sites for ${c.id}`);
    const sorted = (xs: string[]) => [...xs].sort();
    const keys = (cls: 'bad' | 'good') => sorted(sites[cls].map((s) => `${c.id}::${s.site}`));
    if (JSON.stringify(keys('bad')) !== JSON.stringify(sorted(expected.bad)) ||
        JSON.stringify(keys('good')) !== JSON.stringify(sorted(expected.good))) {
      throw new Error(`universe drift vs census for ${c.id}`);
    }
    bad += sites.bad.length;
    good += sites.good.length;
    map.set(c.id, { caseId: c.id, sites, rawBad: rawBad.length, rawGood: rawGood.length });
  }
  if (bad !== census.merged.bad || good !== census.merged.good || bad + good !== census.merged.total) {
    throw new Error(`universe totals drift vs census: got ${bad}/${good}, census ${census.merged.bad}/${census.merged.good}/${census.merged.total}`);
  }
  log(`universe: ${manifest.cases.length} cases, merged ${bad} bad + ${good} good = ${bad + good} sites (== census ✓)`);
  return map;
}

/** Positive-only corpus (LAMeD/MemHint): universe = the labeled flaw sites only. */
function loadPositiveOnlyUniverses(corpusDir: string): Map<string, CaseUniverse> {
  const manifest = JSON.parse(readFileSync(join(ROOT, corpusDir, 'corpus_manifest.json'), 'utf-8')) as { cases: ManifestCase[]; positive_only?: boolean };
  if (!manifest.positive_only) throw new Error(`${corpusDir} is not positive_only — refusing universe scoring`);
  const map = new Map<string, CaseUniverse>();
  for (const c of manifest.cases) {
    const rawBad = (c.flaws ?? []).map((f) => f.function);
    map.set(c.id, { caseId: c.id, sites: { bad: buildCaseUniverse({ bad: rawBad, good: [] }).bad, good: [] }, rawBad: rawBad.length, rawGood: 0 });
  }
  return map;
}

interface RunScore {
  overall: ReturnType<typeof computeMetrics>;
  accounting: ReturnType<typeof buildUniverseAccounting>;
  samples: Sample[];
  ranOk: number;
  excluded: string[];
  oldOverall?: Overall;
  oldSource: string;
}

/** Re-score one `cases/*.json` dir under the fixed universe and write its outputs. */
function rescoreRunDir(label: string, dir: string, universes: Map<string, CaseUniverse>, outDir: string): RunScore {
  const caseDir = join(dir, 'cases');
  const perCase: UniverseCaseResult[] = [];
  const samples: Sample[] = [];
  const excluded: string[] = [];
  let rawBad = 0;
  let rawGood = 0;
  let ranOk = 0;
  for (const f of readdirSync(caseDir).sort()) {
    if (!f.endsWith('.json')) continue;
    const cached = JSON.parse(readFileSync(join(caseDir, f), 'utf-8')) as CachedCaseFile;
    const u = universes.get(cached.id);
    if (!u) {
      excluded.push(cached.id);
      continue;
    }
    if (cached.row.status !== 'ok') {
      excluded.push(cached.id);
      continue;
    }
    const r = scoreCaseUniverse(cached.findings ?? [], cached.id, u.sites);
    perCase.push(r);
    samples.push(...r.samples);
    rawBad += u.rawBad;
    rawGood += u.rawGood;
    ranOk++;
  }
  const accounting = buildUniverseAccounting(perCase, rawBad, rawGood);
  const overall = computeMetrics(accumulate(samples));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'metrics.json'), JSON.stringify({ label, overall, ranOk, excludedCount: excluded.length, excluded }, null, 2));
  writeFileSync(join(outDir, 'universe-accounting.json'), JSON.stringify(accounting, null, 2));
  writeFileSync(join(outDir, 'samples.json'), JSON.stringify(samples, null, 2));

  // old cells: the frozen metrics.json if present, else derived from the case
  // rows (artifact-sourced, never hard-coded) — e.g. zai run-1 has no metrics.json.
  let oldOverall: Overall | undefined;
  let oldSource = 'absent';
  const oldPath = join(dir, 'metrics.json');
  if (existsSync(oldPath)) {
    oldOverall = (JSON.parse(readFileSync(oldPath, 'utf-8')) as { overall: Overall }).overall;
    oldSource = 'metrics.json (.overall)';
  } else {
    let tp = 0, fp = 0, fn = 0, tn = 0, any = false;
    for (const f of readdirSync(caseDir).sort()) {
      if (!f.endsWith('.json')) continue;
      const cached = JSON.parse(readFileSync(join(caseDir, f), 'utf-8')) as CachedCaseFile;
      if (cached.row.status !== 'ok') continue;
      tp += cached.row.tp; fp += cached.row.fp; fn += cached.row.fn; tn += cached.row.tn;
      any = true;
    }
    if (any) {
      oldOverall = { tp, fp, fn, tn, total: tp + fp + fn + tn };
      oldSource = 'sum of per-case rows (no frozen metrics.json)';
    }
  }
  writeFileSync(join(outDir, 'old-vs-new.json'), JSON.stringify({
    label,
    old: oldOverall ? { ...oldOverall, source: oldSource } : { note: 'no frozen old cells on disk' },
    new: {
      tp: overall.tp, fp: overall.fp, fn: overall.fn, tn: overall.tn, total: overall.total,
      precision: overall.precision, recall: overall.recall, f1: overall.f1, mcc: overall.mcc,
      accuracy: overall.accuracy, specificity: overall.specificity,
    },
    samples: { old: oldOverall?.total, new: overall.total },
  }, null, 2));
  return { overall, accounting, samples, ranOk, excluded, oldOverall, oldSource };
}

const cells = (o: { tp: number; fp: number; fn: number; tn: number }) => `${o.tp}/${o.fp}/${o.fn}/${o.tn}`;
const prf = (o: { precision: number; recall: number; f1: number; mcc: number }) =>
  `P ${o.precision.toFixed(3)} R ${o.recall.toFixed(3)} F1 ${o.f1.toFixed(3)} MCC ${o.mcc.toFixed(3)}`;

interface NewCells { tp: number; fp: number; fn: number; tn: number; total: number; precision: number; recall: number; f1: number; mcc: number }

function summaryRow(label: string, oldO: Overall | undefined, newM: NewCells, note = ''): string {
  const oldPart = oldO ? `old ${cells(oldO)} (n=${oldO.total})` : 'old —';
  return `| ${label} | ${oldPart} | new ${cells(newM)} (n=${newM.total}) | ${prf(newM)} | ${note} |`;
}

// ── (a) 9-config Juliet sweep ────────────────────────────────────────────────

interface RunEntry { run: string; dir: string }

function discoverRuns(base: string): Array<{ cfg: string; runs: RunEntry[] }> {
  const out: Array<{ cfg: string; runs: RunEntry[] }> = [];
  for (const cfg of readdirSync(base).sort()) {
    const cfgDir = join(base, cfg);
    let entries: string[];
    try {
      entries = readdirSync(cfgDir);
    } catch {
      continue;
    }
    if (entries.includes('cases')) {
      out.push({ cfg, runs: [{ run: 'flat', dir: cfgDir }] });
    } else {
      const runDirs = entries.filter((e) => /^run-\d+$/.test(e) && existsSync(join(cfgDir, e, 'cases'))).sort();
      if (runDirs.length > 0) out.push({ cfg, runs: runDirs.map((r) => ({ run: r, dir: join(cfgDir, r) })) });
    }
  }
  return out;
}

function meanStat(values: number[]): { mean: number; std: number } {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, std: Math.sqrt(variance) };
}

function rescoreSweep(
  base: string,
  outBase: string,
  universes: Map<string, CaseUniverse>,
  expect: { positives: number; total: number } | undefined,
  tag: string,
) {
  const scored: Array<{ cfg: string; run: string; positives: number; total: number }> = [];
  for (const { cfg, runs } of discoverRuns(base)) {
    const perRun: Array<{ run: string; m: ReturnType<typeof computeMetrics>; old: Overall | undefined; fuCount: number }> = [];
    for (const { run, dir } of runs) {
      const s = rescoreRunDir(`${tag}/${cfg}/${run}`, dir, universes, join(OUT, outBase, cfg, run));
      scored.push({ cfg, run, positives: s.overall.tp + s.overall.fn, total: s.overall.total });
      perRun.push({ run, m: s.overall, old: s.oldOverall, fuCount: s.accounting.flaggedUnlabeled.count });
    }
    if (runs.length > 1) {
      const meanRound = (sel: (m: ReturnType<typeof computeMetrics>) => number) => Math.round(perRun.reduce((a, s) => a + sel(s.m), 0) / perRun.length);
      const f1s = meanStat(perRun.map((s) => s.m.f1));
      const oldMean = perRun.every((s) => s.old)
        ? {
            tp: Math.round(perRun.reduce((a, s) => a + s.old!.tp, 0) / perRun.length),
            fp: Math.round(perRun.reduce((a, s) => a + s.old!.fp, 0) / perRun.length),
            fn: Math.round(perRun.reduce((a, s) => a + s.old!.fn, 0) / perRun.length),
            tn: Math.round(perRun.reduce((a, s) => a + s.old!.tn, 0) / perRun.length),
            total: Math.round(perRun.reduce((a, s) => a + s.old!.total, 0) / perRun.length),
          }
        : undefined;
      const meanRow = {
        cfg,
        runs: perRun.length,
        meanCells: { tp: meanRound((m) => m.tp), fp: meanRound((m) => m.fp), fn: meanRound((m) => m.fn), tn: meanRound((m) => m.tn) },
        f1Mean: f1s.mean,
        f1Std: f1s.std,
        precisionMean: perRun.reduce((a, s) => a + s.m.precision, 0) / perRun.length,
        recallMean: perRun.reduce((a, s) => a + s.m.recall, 0) / perRun.length,
        mccMean: perRun.reduce((a, s) => a + s.m.mcc, 0) / perRun.length,
        oldMeanCells: oldMean,
      };
      mkdirSync(join(OUT, outBase, cfg), { recursive: true });
      writeFileSync(join(OUT, outBase, cfg, 'config-mean.json'), JSON.stringify(meanRow, null, 2));
      summaryLines.push(summaryRow(`${tag} ${cfg} (mean±std, n=${perRun.length} runs)`, oldMean, {
        ...meanRow.meanCells, total: perRun[0].m.total, precision: meanRow.precisionMean, recall: meanRow.recallMean, f1: f1s.mean, mcc: meanRow.mccMean,
      }, `F1 std ${f1s.std.toFixed(4)}`));
    } else {
      const s = perRun[0];
      summaryLines.push(summaryRow(`${tag} ${cfg}`, s.old, s.m, `flaggedUnlabeled ${s.fuCount}`));
    }
  }
  // R-2 structural check: within a target, EVERY config and run shares ONE
  // positive count and ONE sample count. For the full-corpus sweep that count
  // must additionally equal the census (2,557 / 10,314); for stratified subsets
  // (ds5) it equals the subset's own universe.
  const bad = scored.find((s) => s.positives !== scored[0].positives || s.total !== scored[0].total);
  if (bad) throw new Error(`R-2 VIOLATION in ${tag}: ${bad.cfg}/${bad.run} has positives=${bad.positives} samples=${bad.total}, first run had ${scored[0].positives}/${scored[0].total}`);
  if (expect && (scored[0].positives !== expect.positives || scored[0].total !== expect.total)) {
    throw new Error(`R-2 VIOLATION in ${tag}: positives ${scored[0].positives} (want census ${expect.positives}), samples ${scored[0].total} (want ${expect.total})`);
  }
  log(`${tag}: ${scored.length} runs scored; positives=${scored[0].positives} samples=${scored[0].total} identical across all configs${expect ? ' (== census ✓ R-2)' : ' (subset universe)'}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`# rescore-universe · out=${OUT}`);
  log('# zero LLM/API calls; clang leg is the pre-authorized D5 exception');
  mkdirSync(OUT, { recursive: true });

  const juliet = loadJulietUniverses();
  const census = JSON.parse(readFileSync(CENSUS, 'utf-8')) as { merged: { bad: number; good: number; total: number }; raw: { bad: number; good: number } };
  const manifest = JSON.parse(readFileSync(join(JULIET, 'corpus_manifest.json'), 'utf-8')) as { cases: ManifestCase[] };

  // (a) 9-config sweep — every run separately, then mean±std.
  log('\n── (a) baseline sweep ──');
  rescoreSweep(SWEEP, 'sweep', juliet, { positives: census.merged.bad, total: census.merged.total }, 'sweep');

  // (b) FULL-CORPUS clang leg (D5) — system arm is B1's re-score (no re-run).
  log('\n── (b) clang full corpus (D5) ──');
  {
    const t0 = Date.now();
    const adapter = new ClangAnalyzerAdapter();
    if (!(await adapter.available())) throw new Error('clang unavailable — D5 leg aborted');
    const clangDir = join(OUT, 'clang');
    const caseOut = join(clangDir, 'cases');
    mkdirSync(caseOut, { recursive: true });
    const clangOut: UniverseCaseResult[] = [];
    const samples: Sample[] = [];
    const excluded: Array<{ id: string; error: string }> = [];
    let rawBad = 0;
    let rawGood = 0;
    let n = 0;
    for (const c of manifest.cases) {
      const u = juliet.get(c.id)!;
      const started = Date.now();
      let findings: SnapshotFinding[] = [];
      let error: string | undefined;
      try {
        findings = await adapter.run(join(JULIET, c.repo_path ?? `cases/${c.id}`), { id: c.id } as never);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      writeFileSync(join(caseOut, `${c.id}.json`), JSON.stringify({ id: c.id, status: error ? 'error' : 'ok', error, durationMs: Date.now() - started, findings }));
      if (error) {
        excluded.push({ id: c.id, error });
        continue;
      }
      const r = scoreCaseUniverse(findings, c.id, u.sites);
      clangOut.push(r);
      samples.push(...r.samples);
      rawBad += u.rawBad;
      rawGood += u.rawGood;
      n++;
    }
    const wallMs = Date.now() - t0;
    const accounting = buildUniverseAccounting(clangOut, rawBad, rawGood);
    const overall = computeMetrics(accumulate(samples));
    writeFileSync(join(clangDir, 'metrics.json'), JSON.stringify({ label: 'clang-analyzer (full corpus, D5)', overall, ranOk: n, excludedCount: excluded.length, wallClockMs: wallMs }, null, 2));
    writeFileSync(join(clangDir, 'universe-accounting.json'), JSON.stringify(accounting, null, 2));
    writeFileSync(join(clangDir, 'old-vs-new.json'), JSON.stringify({
      label: 'clang-analyzer',
      old: { note: 'extinct: pre-D5 numbers came from an arbitrary first-30 subset on the pre-fix corpus (F1 0.853/0.761, 29TP/7FP, 27TP/12FP) — replaced by this full-corpus run' },
      new: { ...overall },
      wallClockMs: wallMs,
    }, null, 2));
    log(`clang: ${n}/${manifest.cases.length} cases scored, ${excluded.length} excluded, wall ${(wallMs / 1000).toFixed(1)}s`);
    summaryLines.push(`| clang-analyzer (full corpus) | old — extinct 30-case subset | new ${cells(overall)} (n=${overall.total}) | ${prf(overall)} | vs system arm = sweep B1 new row |`);
    log(`clang flaggedUnlabeled: ${accounting.flaggedUnlabeled.count}`);
  }

  // (c) n=50 consensus campaigns + McNemar on the common universe.
  log('\n── (c) n=50 campaigns ──');
  {
    const n50Base = join(ROOT, 'results/consensus-ablation-n50-2026-08-19');
    const arms = ['s1a', 's1b', 'sca', 'scb'];
    const armScores = new Map<string, RunScore>();
    for (const arm of arms) {
      const evalDir = readdirSync(join(n50Base, arm)).find((d) => /^eval-/.test(d) && existsSync(join(n50Base, arm, d, 'cases')));
      if (!evalDir) throw new Error(`no eval-* dir for arm ${arm}`);
      const s = rescoreRunDir(`n50/${arm}`, join(n50Base, arm, evalDir), juliet, join(OUT, 'n50', arm));
      armScores.set(arm, s);
      summaryLines.push(summaryRow(`n50 ${arm}`, s.oldOverall, s.overall, `cases ${s.ranOk}${s.ranOk < 50 ? ' (PRE-NOTED: s1a 49/50)' : ''}`));
    }
    for (const [name, a, b] of [['A', 's1a', 'sca'], ['B', 's1b', 'scb']] as const) {
      const sa = armScores.get(a)!.samples;
      const sb = armScores.get(b)!.samples;
      const res = mcnemar(sa, sb);
      writeFileSync(join(OUT, 'n50', `mcnemar-${name}.json`), JSON.stringify({ pair: `${a} vs ${b}`, ...res }, null, 2));
      log(`mcnemar ${a} vs ${b}: n=${res.n} b01=${res.b01} b10=${res.b10} χ²=${res.chi2.toFixed(4)} p=${res.pValue.toExponential(3)}`);
      summaryLines.push(`| McNemar ${a} vs ${b} | — | n=${res.n} b01=${res.b01} b10=${res.b10} χ²=${res.chi2.toFixed(3)} p=${res.pValue.toExponential(2)} | — | recomputed on the common siteIds |`);
    }
    // Verdict-level flip rates (for the record; NOT F1 changes).
    const flips: Record<string, { shared: number; flipped: number; rate: number }> = {};
    for (const [name, a, b] of [['A', 's1a', 'sca'], ['B', 's1b', 'scb']] as const) {
      const dirA = join(n50Base, a);
      const dirB = join(n50Base, b);
      const evalA = join(dirA, readdirSync(dirA).find((d) => /^eval-/.test(d) && existsSync(join(dirA, d, 'cases')))!);
      const evalB = join(dirB, readdirSync(dirB).find((d) => /^eval-/.test(d) && existsSync(join(dirB, d, 'cases')))!);
      const flaggedSet = (base: string, id: string) => {
        const f = (JSON.parse(readFileSync(join(base, 'cases', `${id}.json`), 'utf-8')) as CachedCaseFile).findings ?? [];
        return JSON.stringify(f.filter((x) => isFlagged(x.verdict)).map((x) => (x.function ?? '').trim().toLowerCase()).sort());
      };
      let shared = 0;
      let flipped = 0;
      for (const f of readdirSync(join(evalA, 'cases'))) {
        if (!f.endsWith('.json') || !existsSync(join(evalB, 'cases', f))) continue;
        shared++;
        if (flaggedSet(evalA, f.replace(/\.json$/, '')) !== flaggedSet(evalB, f.replace(/\.json$/, ''))) flipped++;
      }
      flips[name] = { shared, flipped, rate: shared ? flipped / shared : 0 };
      log(`verdict flips ${a} vs ${b}: ${flipped}/${shared} = ${(flips[name].rate * 100).toFixed(1)}%`);
    }
    writeFileSync(join(OUT, 'n50', 'verdict-flips.json'), JSON.stringify(flips, null, 2));
  }

  // (d) provider runs.
  log('\n── (d) provider-robustness ──');
  {
    const mimo = rescoreRunDir('provider/mimo', join(ROOT, 'results/baseline-sweep-B6a-mimo-2026-08-17T16-52-13/B6a'), juliet, join(OUT, 'provider', 'mimo'));
    summaryLines.push(summaryRow('provider mimo (B6a)', mimo.oldOverall, mimo.overall, `flaggedUnlabeled ${mimo.accounting.flaggedUnlabeled.count}`));
    const zai = rescoreRunDir('provider/zai-run1', join(ROOT, 'results/baseline-sweep-B6a-zai-2026-08-19T04-25-01/B6a/run-1'), juliet, join(OUT, 'provider', 'zai-run1'));
    summaryLines.push(summaryRow('provider zai run-1 (B6a; glm-5.2)', zai.oldOverall, zai.overall, `run-2 (22 files) EXCLUDED; old from ${zai.oldSource}`));
  }

  // (e) stable-by-luck surviving run — DEVIATION pre-logged: single survivor.
  log('\n── (e) stable-by-luck survivor ──');
  {
    const s = rescoreRunDir(
      'stable-by-luck/eval-2026-06-17T13-33-20',
      join(ROOT, 'results/eval-juliet_cwe401-llm_assisted-2026-06-17T13-33-20'),
      juliet,
      join(OUT, 'stable-by-luck', 'eval-2026-06-17T13-33-20'),
    );
    summaryLines.push(summaryRow('stable-by-luck (30-case survivor)', s.oldOverall, s.overall, 'DEVIATION: pair partner NOT on disk — flip rate NOT recomputable (pre-logged)'));
    log('ESCALATION NOTE (pre-logged in Todo 1): the stable-by-luck pair exists only as this single survivor; the 27/8/5/37 flip-rate claim cannot be re-derived.');
  }

  // (f) ds5-juliet-50 + the ds5-3d tool-ablation dirs.
  log('\n── (f) ds5 stratified n=50 + ds5-3d tool ablation ──');
  rescoreSweep(join(ROOT, 'results/ds5-juliet-50'), 'ds5-juliet-50', juliet, undefined, 'ds5-juliet-50');
  for (const d of ['ds5-3d-none', 'ds5-3d-functionSummary', 'ds5-3d-pathConstraints', 'ds5-3d-functionSummary,pathConstraints']) {
    const s = rescoreRunDir(`ds5-3d/${d}`, join(ROOT, 'results', d, 'B1'), juliet, join(OUT, 'ds5-3d', d));
    summaryLines.push(summaryRow(`ds5-3d ${d} (B1)`, s.oldOverall, s.overall, 'tool ablation leg'));
  }

  // (g) LAMeD/MemHint verify-only — ANY drift → ESCALATE + stop.
  log('\n── (g) LAMeD / MemHint (verify-only) ──');
  const lamedU = loadPositiveOnlyUniverses('demo/lamed');
  const memhintU = loadPositiveOnlyUniverses('demo/memhint');
  // Root-cause aid for the drift check: which raw labels collapsed into one
  // site (the printed numbers were computed on UNMERGED label counts, so any
  // multi-member site moves the denominator by design).
  for (const [name, u] of [['lamed', lamedU], ['memhint', memhintU]] as const) {
    let raw = 0;
    let merged = 0;
    const groups: Array<{ caseId: string; members: string[] }> = [];
    for (const { caseId, sites, rawBad } of u.values()) {
      raw += rawBad;
      merged += sites.bad.length;
      for (const s of sites.bad) if (s.members.length > 1) groups.push({ caseId, members: [...s.members].sort() });
    }
    log(`${name} label census: raw ${raw} -> merged ${merged} sites (${groups.length} merge groups)`);
    for (const g of groups) log(`  ${name} merge ${g.caseId}: ${g.members.join(' + ')}`);
  }
  const verify = (tag: string, dir: string, universes: Map<string, CaseUniverse>, outSub: string) => {
    const s = rescoreRunDir(`${tag}`, dir, universes, join(OUT, outSub));
    const old = s.oldOverall;
    const drift = !!old && (old.tp !== s.overall.tp || old.fp !== s.overall.fp || old.fn !== s.overall.fn || old.tn !== s.overall.tn);
    const line = summaryRow(`${tag}`, old, s.overall, drift ? 'DRIFT' : 'verify-only: matches');
    summaryLines.push(line);
    if (drift) {
      escalate = true;
      logErr(`ESCALATE: ${tag} drifted — old ${cells(old!)} vs new ${cells(s.overall)} (printed numbers must not change without the user's decision)`);
    } else {
      log(`${tag}: verify OK (old ${old ? cells(old) : '—'} == new ${cells(s.overall)})`);
    }
  };
  verify('lamed/no_llm-default', join(ROOT, 'results/lamed-no_llm-default-2026-08-20'), lamedU, 'lamed/no_llm-default');
  verify('lamed/no_llm-ipf', join(ROOT, 'results/lamed-no_llm-ipf-2026-08-20'), lamedU, 'lamed/no_llm-ipf');
  for (const r of ['run-1', 'run-2', 'run-3']) {
    verify(`lamed/llm_assisted/${r}`, join(ROOT, 'results/lamed-llm_assisted-2026-08-20', r), lamedU, `lamed/llm_assisted-${r}`);
  }
  verify('memhint/no_llm', join(ROOT, 'results/memhint-no_llm-2026-08-28'), memhintU, 'memhint/no_llm');
  for (const r of ['run1', 'run2', 'run3']) {
    verify(`memhint/llm_assisted-${r}`, join(ROOT, `results/memhint-llm-assisted-2026-08-28-${r}`), memhintU, `memhint/llm-${r}`);
  }
  log('note: lamed-baseline-2026-08-20 is a Clang-SA comparison summary (no per-case findings on disk) — nothing to re-score; recorded as-is.');

  // summary
  const header = '# old-vs-new summary (fixed universe re-score)\n\n'
    + '| target | old (frozen) | new | metrics | note |\n|---|---|---|---|---|\n';
  writeFileSync(join(OUT, 'old-vs-new-summary.md'), header + summaryLines.join('\n') + '\n');
  log('\n' + header + summaryLines.join('\n'));
  const b1Acc = JSON.parse(readFileSync(join(OUT, 'sweep/B1/flat/universe-accounting.json'), 'utf-8')) as { flaggedUnlabeled: { count: number } };
  log(`\nB1 flaggedUnlabeled count: ${b1Acc.flaggedUnlabeled.count} (review's old-scorer expectation was 66 at unlabeled functions — different mechanism, both counted)`);

  writeFileSync(join(OUT, 'rescore-log.txt'), logLines.join('\n'));
  if (escalate) {
    logErr('\nESCALATE: LAMeD/MemHint verify drift — STOP before Phase B (paper updates). Orchestrator decision required.');
    process.exit(2);
  }
  log('\nDONE — all targets re-scored; positive counts identical across Juliet configs (R-2 ✓).');
}

main().catch((e) => {
  logErr(`FATAL: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
