/**
 * useCommands — command dispatch hook for the TUI. Encapsulates all /command
 * handlers, option appliers, and helpers that were previously inline in App.tsx.
 * The App component retains overlay state management and the submit wrapper.
 */

import { useRef } from 'react';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findCommand } from '../commands';
import { glyph, color, formatDuration } from '../theme';
import { runTuiScan } from '../runner';
import { runTuiEval } from '../evalRunner';
import { snapshotFindingToView } from '../findings/findingView';
import type { TuiStore } from '../../../stores';
import type { SelectOption } from '../components/Select';

// ── Types ──

export interface Overlay {
  title: string;
  options: SelectOption[];
  multi?: boolean;
  onSubmit: (values: string[]) => void;
}

// ── Hook ──

export function useCommands(
  store: TuiStore,
  exit: () => void,
  resultsDir: string,
  setOverlay: (overlay: Overlay | null) => void,
  staticUrl?: string,
  dynamicUrl?: string,
) {
  const evalBusy = useRef(false);

  // ── Option appliers (shared by typed-arg and the select overlay) ──

  const applyMode = (v: string) => {
    const state = store.getSnapshot();
    if (v === 'no_llm' || v === 'llm_assisted') {
      store.setOptions({ mode: v });
      store.addSystemMessage(
        `mode = ${v}${state.status === 'running' ? ' (applies to the next scan)' : ''}`,
      );
    } else store.addSystemMessage('usage: /mode no_llm|llm_assisted');
  };

  const applyDynamic = (v: string) => {
    const state = store.getSnapshot();
    if (v === 'off' || v === 'selective' || v === 'aggressive') {
      store.setOptions({ dynamic: v });
      store.addSystemMessage(
        `dynamic = ${v}${state.status === 'running' ? ' (applies to the next scan)' : ''}`,
      );
    } else store.addSystemMessage('usage: /dynamic off|selective|aggressive');
  };

  // ── Select overlay (for commands with enumerated options) ──

  const openSelect = (cmd: string, apply: (v: string) => void, initial?: string) => {
    const spec = findCommand(cmd);
    if (!spec?.options) return;
    setOverlay({
      title: `${cmd} ${glyph.bullet} choose`,
      options: spec.options.map((o) => ({
        ...o,
        color: o.value === initial ? color.accent : undefined,
      })),
      onSubmit: (vals) => apply(vals[0]),
    });
  };

  // ── Report browser (reads snapshot.json from disk) ──

  const openReport = (scanId?: string) => {
    const id = scanId ?? mostRecentScanId(resultsDir);
    if (!id) return listScans(store, resultsDir);
    const path = join(resultsDir, id, 'snapshot.json');
    if (!existsSync(path)) return store.addSystemMessage(`no snapshot for "${id}" (try /scans)`);
    let snap: any;
    try {
      snap = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err: any) {
      return store.addSystemMessage(`failed to read ${id}: ${err?.message ?? err}`);
    }
    const findings: any[] = snap.findings ?? [];
    if (findings.length === 0) return store.addSystemMessage(`${id}: no findings`);
    // Open the interactive findings/verdict browser over the snapshot (the single
    // `snapshotFindingToView` adapter guarantees parity with the live path).
    store.openFindings(id, 'snapshot', findings.map(snapshotFindingToView));
  };

  // ── Command dispatch (the main switch/router for all /commands) ──

  const dispatch = (raw: string) => {
    const state = store.getSnapshot();

    // Plain text (not a /command): resume a paused agent, steer a running one, or hint when idle.
    if (!raw.startsWith('/')) {
      if (state.status === 'paused') {
        store.addUserMessage(raw);
        store.enqueueSteering(raw);
        store.resume();
      } else if (state.status === 'running') {
        store.addUserMessage(raw);
        store.enqueueSteering(raw);
        store.addSystemMessage('↳ queued — the agent will read this on its next turn');
      } else {
        store.addSystemMessage('type a /command (type / to see them all)');
      }
      return;
    }

    const [cmd, ...rest] = raw.split(/\s+/);
    const arg = rest.join(' ');

    switch (cmd) {
      case '/quit':
      case '/exit':
        exit();
        return;

      case '/mode':
        arg ? applyMode(arg) : openSelect('/mode', applyMode, state.mode);
        return;

      case '/dynamic':
        arg ? applyDynamic(arg) : openSelect('/dynamic', applyDynamic, state.dynamic);
        return;

      case '/preflight':
        void doPreflight(store, staticUrl, dynamicUrl);
        return;

      case '/scans':
        listScans(store, resultsDir);
        return;

      case '/config':
        store.setView('config');
        return;

      case '/report':
        openReport(arg || undefined);
        return;

      case '/metrics':
        showMetrics(store, resultsDir, arg || undefined);
        return;

      case '/tools':
        void listTools(store, staticUrl, dynamicUrl);
        return;

      case '/scan': {
        // Read the freshest options from the store (not the render closure) so a
        // mode/dynamic just chosen from a picker always applies to this scan.
        const snap = store.getSnapshot();
        if (evalBusy.current) {
          store.addSystemMessage('an eval is running — wait for it to finish before scanning');
          return;
        }
        if (snap.status === 'running') {
          store.addSystemMessage(
            'a scan is running — press ESC to interrupt, or type a message to steer the agent',
          );
          return;
        }
        if (!arg) {
          store.addSystemMessage('usage: /scan <repo-path>');
          return;
        }
        store.addUserMessage(`/scan ${arg} (mode ${snap.mode}, dynamic ${snap.dynamic})`);
        void runTuiScan(store, {
          repo: arg,
          mode: snap.mode,
          dynamic: snap.dynamic,
          staticUrl,
          dynamicUrl,
        });
        return;
      }

      case '/eval': {
        // /eval <corpus-path> [limit] [c=N] [--resume] — uses the current /mode + /dynamic.
        // /eval with no path re-opens the live/last dashboard (e.g. after Esc'ing out).
        const snap = store.getSnapshot();
        const tokens = rest.filter((t) => t.length > 0);
        // corpus = first token that's not a flag, not a bare number, not c=N
        const corpus = tokens.find(
          (t) => !t.startsWith('--') && !/^\d+$/.test(t) && !/^c=\d+$/i.test(t),
        );
        if (!corpus) {
          if (snap.eval) {
            store.setView('eval');
          } else {
            store.addSystemMessage('usage: /eval <corpus-path> [limit] [c=N parallel] [--resume]');
          }
          return;
        }
        if (evalBusy.current) {
          store.addSystemMessage('an eval is already running — type /eval (no args) to watch it');
          return;
        }
        if (snap.status === 'running') {
          store.addSystemMessage('a scan is running — wait for it to finish before evaluating');
          return;
        }
        const limitTok = tokens.find((t) => /^\d+$/.test(t));
        const limit = limitTok ? parseInt(limitTok, 10) : undefined;
        const concTok = tokens.find((t) => /^c=\d+$/i.test(t));
        const concurrency = concTok ? parseInt(concTok.slice(2), 10) : undefined;
        const resume = tokens.includes('--resume');
        store.addUserMessage(
          `/eval ${corpus} (mode ${snap.mode}, dynamic ${snap.dynamic}${limit ? `, limit ${limit}` : ''}` +
            `${concurrency ? `, c=${concurrency}` : ''}${resume ? ', resume' : ''})`,
        );
        evalBusy.current = true;
        void runTuiEval(
          store,
          { corpus, mode: snap.mode, dynamic: snap.dynamic, limit, concurrency, resume, staticUrl, dynamicUrl },
        ).finally(() => {
          evalBusy.current = false;
        });
        return;
      }

      default:
        store.addSystemMessage(`unknown command: ${cmd} — type / to see available commands`);
    }
  };

  return { dispatch, openReport, showMetrics, openSelect };
}

// ── Module-level helpers (no component state needed) ──

/** Show the descriptive metrics for a scan (results/<id>/metrics.json). */
function showMetrics(store: TuiStore, resultsDir: string, scanId?: string): void {
  const id = scanId ?? mostRecentScanId(resultsDir);
  if (!id) return store.addSystemMessage('no scans yet');
  const path = join(resultsDir, id, 'metrics.json');
  if (!existsSync(path))
    return store.addSystemMessage(`no metrics for "${id}" (re-run the scan to generate it)`);
  let m: any;
  try {
    m = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err: any) {
    return store.addSystemMessage(`failed to read metrics: ${err?.message ?? err}`);
  }
  const verdicts = Object.entries(m.verdicts ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
  const roots = Object.entries(m.root_cause_counts ?? {})
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');
  store.addSystemMessage(`── metrics ${id} ──`);
  store.addSystemMessage(
    `  mode: ${m.mode}${m.dynamic !== 'off' ? ` +dynamic(${m.dynamic})` : ''} · candidates: ${m.candidates} · ${m.confirmed} confirmed / ${m.likely} likely`,
  );
  if (verdicts) store.addSystemMessage(`  verdicts: ${verdicts}`);
  store.addSystemMessage(
    `  confidence: mean ${(m.confidence?.mean ?? 0).toFixed(2)} (min ${(m.confidence?.min ?? 0).toFixed(2)}, max ${(m.confidence?.max ?? 0).toFixed(2)})`,
  );
  if (roots) store.addSystemMessage(`  root causes: ${roots}`);
  store.addSystemMessage(
    `  evidence: ${m.evidence_count ?? 0} · tools: ${(m.tools_used ?? []).join(', ') || 'none'}`,
  );
  store.addSystemMessage(
    `  cost: ${m.turns ?? '?'} turns · ${m.total_tokens ?? 0} tokens · ${m.duration_ms != null ? formatDuration(m.duration_ms) : '?'}`,
  );
}

/** Most recent scan id under the results dir (for `/report` with no arg). */
function mostRecentScanId(resultsDir: string): string | undefined {
  if (!existsSync(resultsDir)) return undefined;
  return readdirSync(resultsDir)
    .filter((n) => n.startsWith('scan_'))
    .map((n) => ({ n, t: statSync(join(resultsDir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0]?.n;
}

/** Standalone connectivity check (the scan does its own, but this lets you verify before scanning). */
async function doPreflight(store: TuiStore, staticUrl?: string, dynamicUrl?: string) {
  const { McpClient } = await import('@cleak/agent-core');
  const { loadConfig } = await import('../../../config');
  const cfg = loadConfig({
    ...(staticUrl ? { staticUrl } : {}),
    ...(dynamicUrl ? { dynamicUrl } : {}),
  });
  store.addSystemMessage('preflight: checking analyzers…');
  for (const [label, url] of [
    ['static', cfg.staticUrl],
    ['dynamic', cfg.dynamicUrl],
  ] as const) {
    const client = new McpClient(url, label);
    try {
      const tools = await client.listTools();
      store.addSystemMessage(`✓ ${label} ${url} — ${tools.length} tools`);
    } catch (err: any) {
      store.addSystemMessage(`✗ ${label} ${url} — ${err?.message ?? err}`);
    } finally {
      await client.close();
    }
  }
}

/** List recent scans (with their leak counts) so they can be reviewed. */
function listScans(store: TuiStore, resultsDir: string) {
  if (!existsSync(resultsDir)) {
    store.addSystemMessage('no scans yet');
    return;
  }
  const dirs = readdirSync(resultsDir)
    .filter((n) => n.startsWith('scan_'))
    .map((n) => ({ n, t: statSync(join(resultsDir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, 12);
  if (dirs.length === 0) {
    store.addSystemMessage('no scans yet');
    return;
  }
  store.addSystemMessage(`recent scans (${dirs.length}):`);
  for (const d of dirs) {
    let info = '';
    try {
      const s = JSON.parse(readFileSync(join(resultsDir, d.n, 'snapshot.json'), 'utf-8'));
      info = ` — ${s.confirmed_leak_count}C/${s.likely_leak_count}L of ${s.finding_count}`;
    } catch {
      /* no snapshot */
    }
    store.addSystemMessage(`  ${d.n}${info}`);
  }
  store.addSystemMessage('view one with /report <scanId>');
}

async function listTools(store: TuiStore, staticUrl?: string, dynamicUrl?: string) {
  const { McpClient } = await import('@cleak/agent-core');
  const { loadConfig } = await import('../../../config');
  const cfg = loadConfig({
    ...(staticUrl ? { staticUrl } : {}),
    ...(dynamicUrl ? { dynamicUrl } : {}),
  });
  for (const [label, url] of [
    ['static', cfg.staticUrl],
    ['dynamic', cfg.dynamicUrl],
  ] as const) {
    const client = new McpClient(url, label);
    try {
      const tools = await client.listTools();
      store.addSystemMessage(`${label} (${url}): ${tools.map((t) => t.name).join(', ')}`);
    } catch (err: any) {
      store.addSystemMessage(`${label} (${url}): ${err?.message ?? err}`);
    } finally {
      await client.close();
    }
  }
}
