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
import { loadPreferences } from './preferences';

export interface LaunchTuiOptions {
  provider?: Provider;
  staticUrl?: string;
  dynamicUrl?: string;
  mode?: 'no_llm' | 'llm_assisted';
  dynamic?: 'off' | 'selective' | 'aggressive';
}

export async function launchTui(opts: LaunchTuiOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'The interactive TUI requires a terminal (TTY). For non-interactive runs use:\n' +
        '  leak-tui scan --repo <path> --mode llm_assisted\n',
    );
    process.exitCode = 1;
    return;
  }
  loadEnvFiles();
  const prefs = loadPreferences();
  // Precedence: explicit CLI flag > saved preference > built-in default.
  const cfg = loadConfig({ provider: opts.provider ?? prefs.defaultProvider });
  const store = new TuiStore({
    provider: cfg.provider,
    model: cfg.llm.model,
    mode: opts.mode ?? prefs.defaultMode,
    dynamic: opts.dynamic ?? prefs.defaultDynamic,
    autoShowReport: prefs.autoShowReport,
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
