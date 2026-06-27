/**
 * Launch the interactive Ink TUI. Loads env (LLM key), seeds the store with the
 * resolved provider/model, and renders the App.
 */

import { render } from 'ink';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { App } from './App';
import { TuiStore } from './store';
import { loadEnvFiles } from '../../domain/env';
import { loadConfig, type Provider } from '../../config';
import { loadConfigFile } from '../../domain/config-file';

export interface LaunchTuiOptions {
  provider?: Provider;
  /** Custom LLM endpoint overrides (CLI flags; win over saved prefs + env). */
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  staticUrl?: string;
  dynamicUrl?: string;
  mode?: 'no_llm' | 'llm_assisted';
  dynamic?: 'off' | 'selective' | 'aggressive';
}

/** Treat blank/whitespace as "unset" so an empty override never clobbers env/default. */
const nonEmpty = (s?: string): string | undefined => (s && s.trim() ? s : undefined);

export async function launchTui(opts: LaunchTuiOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'The interactive TUI requires a terminal (TTY). For non-interactive runs use:\n' +
        '  cleak scan --repo <path> --mode llm_assisted\n',
    );
    process.exitCode = 1;
    return;
  }
  loadEnvFiles();
  const file = loadConfigFile();
  // Precedence: CLI flag > env > config file > default. Only real flags become
  // overrides here; the config file is absorbed INSIDE loadConfig (below env), so
  // provider/endpoints/staticUrl/… resolve with the right precedence. The TUI-only
  // session defaults (mode/dynamic/autoShowReport) aren't in RunConfig → read direct.
  const cfg = loadConfig({
    provider: opts.provider,
    llm: { baseUrl: nonEmpty(opts.baseUrl), model: nonEmpty(opts.model), apiKey: nonEmpty(opts.apiKey) },
    ...(nonEmpty(opts.staticUrl) ? { staticUrl: opts.staticUrl } : {}),
    ...(nonEmpty(opts.dynamicUrl) ? { dynamicUrl: opts.dynamicUrl } : {}),
  });
  const store = new TuiStore({
    provider: cfg.provider,
    model: cfg.llm.model,
    baseUrl: cfg.llm.baseUrl,
    apiKey: cfg.llm.apiKey,
    mode: opts.mode ?? file.defaultMode ?? 'llm_assisted',
    dynamic: opts.dynamic ?? file.defaultDynamic ?? 'off',
    autoShowReport: file.autoShowReport ?? false,
  });
  const resultsDir = resolve(cfg.resultsDir);
  const { waitUntilExit } = render(
    <App
      store={store}
      staticUrl={opts.staticUrl ?? cfg.staticUrl}
      dynamicUrl={opts.dynamicUrl ?? cfg.dynamicUrl}
      cwd={process.cwd()}
      resultsDir={resultsDir}
      recentScans={listRecentScans(resultsDir)}
    />,
    { exitOnCtrlC: false },
  );
  await waitUntilExit();
}

/** Most recent scan ids under the results dir (for the welcome's recent-activity column). */
function listRecentScans(resultsDir: string, limit = 3): string[] {
  if (!existsSync(resultsDir)) return [];
  try {
    return readdirSync(resultsDir)
      .filter((n) => n.startsWith('scan_'))
      .map((n) => ({ n, t: statSync(join(resultsDir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, limit)
      .map((x) => x.n);
  } catch {
    return [];
  }
}
