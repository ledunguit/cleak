/**
 * Hand-rolled flag parsing, same style as `scripts/evaluate-corpus.ts` /
 * `scripts/run-baselines.ts` (not `commander` — consistency with those siblings).
 * Superset of `evaluate-corpus.ts`'s flag surface plus this CLI's own additions
 * (auto-ingest, Juliet source, --yes, --set-endpoint, --interactive).
 */
import type { Provider } from '@cleak/config';

export interface CliFlags {
  mode?: 'no_llm' | 'llm_assisted';
  corpus?: string;
  limit?: number;
  runs?: number;
  dynamic?: 'off' | 'selective' | 'aggressive';
  stratify?: string;
  randomSeed?: number;
  resume?: boolean;
  outDir?: string;
  concurrency?: number;
  staticTools?: string[];
  enrich?: boolean;
  strategy?: 'auto' | 'off';
  toolSelect?: boolean;
  staticDiscovery?: boolean;
  consensusN?: number;
  consensusRule?: 'majority' | 'weighted' | 'unanimous-to-flag';
  maxCaseMs?: number;
  maxCaseCostUsd?: number;
  staticUrl?: string;
  dynamicUrl?: string;
  allowUnvalidated?: boolean;
  provider?: Provider;
  dryRun: boolean;
  verbose: boolean;
  interactive: boolean;
  yes: boolean;
  autoIngest: boolean;
  /** Disambiguates what to ingest when --corpus points at a directory that isn't
   * one of the 3 known default paths (e.g. a fresh smoke-test dir). */
  ingestKind?: 'juliet' | 'lamed' | 'memhint';
  julietRoot?: string;
  julietZip?: string;
  /** Repeatable `<provider>.<field>=<value>` — e.g. `openai-compat.baseUrl=http://...`. */
  setEndpoint: string[];
  /** One or more `configs/baselines/*.yaml` ids to run as a sweep (repeatable or
   * comma-separated), e.g. `--baseline B1,B7` or `--baseline B1 --baseline B7`.
   * Presence of this (or --all-baselines) switches the CLI into sweep mode. */
  baseline?: string[];
  /** Sweep every config in --baselines-dir, ignoring --baseline. */
  allBaselines: boolean;
  baselinesDir?: string;
  /** Include baseline configs the engine can't yet run faithfully (mirrors
   * run-baselines.ts's --include-unwired). */
  includeUnwired: boolean;
  help: boolean;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function flagAll(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === `--${name}` && argv[i + 1]) out.push(argv[i + 1]);
  return out;
}
function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}
function boolFlag(argv: string[], onName: string, offName: string): boolean | undefined {
  if (has(argv, onName)) return true;
  if (has(argv, offName)) return false;
  return undefined;
}

export function parseFlags(argv: string[] = process.argv.slice(2)): CliFlags {
  const mode = argv[0] && !argv[0].startsWith('--') ? (argv[0] as 'no_llm' | 'llm_assisted') : undefined;

  const limitRaw = flag(argv, 'limit');
  const runsRaw = flag(argv, 'runs');
  const concurrencyRaw = flag(argv, 'concurrency');
  const randomSeedRaw = flag(argv, 'random-seed');
  const consensusNRaw = flag(argv, 'consensus-n');
  const maxCaseMsRaw = flag(argv, 'max-case-ms');
  const maxCaseCostUsdRaw = flag(argv, 'max-case-cost-usd');

  const stratifyVal = flag(argv, 'stratify');
  const hasStratify = has(argv, 'stratify');
  const stratify = hasStratify ? (!stratifyVal || stratifyVal.startsWith('--') ? 'functionalVariant' : stratifyVal) : undefined;

  const staticToolsRaw = flag(argv, 'static-tools');
  const staticTools =
    staticToolsRaw === undefined
      ? undefined
      : staticToolsRaw === 'none' || staticToolsRaw === ''
        ? []
        : staticToolsRaw.split(',').map((s) => s.trim()).filter(Boolean);

  return {
    mode,
    corpus: flag(argv, 'corpus'),
    limit: limitRaw ? parseInt(limitRaw, 10) : undefined,
    runs: runsRaw ? Math.max(1, parseInt(runsRaw, 10)) : undefined,
    dynamic: flag(argv, 'dynamic') as CliFlags['dynamic'],
    stratify,
    randomSeed: randomSeedRaw ? parseInt(randomSeedRaw, 10) : undefined,
    resume: has(argv, 'resume') ? true : undefined,
    outDir: flag(argv, 'out-dir'),
    concurrency: concurrencyRaw ? Math.max(1, parseInt(concurrencyRaw, 10)) : undefined,
    staticTools,
    enrich: boolFlag(argv, 'enrich', 'no-enrich'),
    strategy: flag(argv, 'strategy') as CliFlags['strategy'],
    toolSelect: boolFlag(argv, 'tool-select', 'no-tool-select'),
    staticDiscovery: boolFlag(argv, 'static-discovery', 'no-static-discovery'),
    consensusN: consensusNRaw ? Math.max(1, parseInt(consensusNRaw, 10)) : undefined,
    consensusRule: flag(argv, 'consensus-rule') as CliFlags['consensusRule'],
    maxCaseMs: maxCaseMsRaw ? Math.max(0, parseInt(maxCaseMsRaw, 10)) : undefined,
    maxCaseCostUsd: maxCaseCostUsdRaw ? Math.max(0, parseFloat(maxCaseCostUsdRaw)) : undefined,
    staticUrl: flag(argv, 'static-url'),
    dynamicUrl: flag(argv, 'dynamic-url'),
    allowUnvalidated: has(argv, 'allow-unvalidated') ? true : undefined,
    provider: flag(argv, 'provider') as Provider | undefined,
    dryRun: has(argv, 'dry-run'),
    verbose: has(argv, 'verbose') || argv.includes('-v'),
    interactive: has(argv, 'interactive'),
    yes: has(argv, 'yes') || argv.includes('-y'),
    autoIngest: has(argv, 'auto-ingest'),
    ingestKind: flag(argv, 'ingest-kind') as CliFlags['ingestKind'],
    julietRoot: flag(argv, 'juliet-root'),
    julietZip: flag(argv, 'juliet-zip'),
    setEndpoint: flagAll(argv, 'set-endpoint'),
    baseline: (() => {
      const ids = flagAll(argv, 'baseline').flatMap((s) => s.split(',').map((x) => x.trim()).filter(Boolean));
      return ids.length ? ids : undefined;
    })(),
    allBaselines: has(argv, 'all-baselines'),
    baselinesDir: flag(argv, 'baselines-dir'),
    includeUnwired: has(argv, 'include-unwired'),
    help: has(argv, 'help') || argv.includes('-h'),
  };
}

export const HELP_TEXT = `Usage: tsx evaluation/cli.ts [mode] [options]

Standalone evaluation CLI — same core as the TUI's /eval, no TUI required.
Omit --corpus (or pass --interactive) to launch the guided wizard; supply
enough flags for a fully non-interactive run otherwise (CI-friendly).

Mode:
  no_llm                  Deterministic heuristic (default: llm_assisted)

Corpus / sampling:
  --corpus <dir>           Corpus directory (e.g. demo/juliet_cwe401)
  --limit <n>              Only evaluate N cases
  --stratify [key]         Stratify sample evenly across a case key
  --random-seed <n>        Seeded random sampling (mutually exclusive with --stratify)
  --resume                 Resume previous eval (needs --out-dir pointed at the prior run)
  --out-dir <path>         Explicit output dir

Run shape:
  --runs <n>               Run N times, report mean ± std variance (default: 1)
  --dynamic <off|selective|aggressive>
  --concurrency <n>        Parallel case concurrency (harness default: 3)

LLM / judge:
  --provider <local|openai|anthropic|openai-compat>
  --consensus-n <n> / --consensus-rule <majority|weighted|unanimous-to-flag>
  --strategy <auto|off>
  --enrich / --no-enrich
  --tool-select / --no-tool-select
  --static-discovery / --no-static-discovery
  --static-tools <list>    Comma-separated static evidence tools ('none' to disable)
  --max-case-ms <n> / --max-case-cost-usd <n>

Ingest (only reachable via --interactive, since flag-only mode never auto-ingests):
  --auto-ingest            Skip the "ingest now?" confirm — just do it
  --ingest-kind <juliet|lamed|memhint>   What to ingest when --corpus is a fresh/unknown dir
  --juliet-root <path>     Pre-extracted Juliet root (for the Juliet ingest sub-flow)
  --juliet-zip <path>      Path to the NIST zip (auto-extracted)

Baseline ablation sweep (configs/baselines/*.yaml — capability profiles B1..B7):
  --baseline <id[,id...]>  Run these baseline configs instead of a single custom plan
                           (repeatable: --baseline B1 --baseline B7). Writes a
                           comparison table (baseline-sweep.{md,csv,tex,json}) to --out-dir.
  --all-baselines          Sweep every config in --baselines-dir
  --baselines-dir <dir>    Default: configs/baselines
  --include-unwired        Include configs the engine can't yet run faithfully
  (--consensus-n/--runs/--enrich/--static-tools override every swept config's own
   defaults, same as scripts/run-baselines.ts)

Config:
  --set-endpoint <provider>.<field>=<value>   Repeatable; persists to ~/.config/cleak/config.json
  --static-url <url> / --dynamic-url <url>
  --allow-unvalidated      Bypass the corpus integrity gate

Misc:
  --interactive            Force the wizard even if --corpus is supplied
  --yes, -y                Accept default-No confirms non-interactively (CI)
  --verbose, -v             Per-phase detail during scan
  --dry-run                 Print the resolved plan and exit
  --help, -h`;
