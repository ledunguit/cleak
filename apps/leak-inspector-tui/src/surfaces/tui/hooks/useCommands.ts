/**
 * useCommands — command dispatch hook for the TUI. Encapsulates all /command
 * handlers, option appliers, and helpers that were previously inline in App.tsx.
 * The App component retains overlay state management and the submit wrapper.
 */

import { useRef } from 'react';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findCommand, COMMANDS } from '../commands';
import { glyph, color, formatDuration } from '../theme';
import { runTuiScan } from '../runner';
import { runTuiEval, type TuiEvalRequest } from '../evalRunner';
import { snapshotFindingToView } from '../findings/findingView';
import { generateScanPlan } from '../../../domain/scanPlan';
import { listEvalRuns, loadEvalRun, resolveHistoricalRun } from '../../../domain/evalHistory';
import type { TuiStore } from '../../../stores';
import type { RunConfig } from '@cleak/config';
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

  /** Shared by the `/eval <args>` dispatch case AND the eval-setup wizard
   * (`EvalSetupScreen`) — same busy/scan-running guards, same launch path.
   * `staticUrl`/`dynamicUrl` default from THIS hook's own closure params (the
   * `--static-url`/`--dynamic-url` CLI overrides) when the caller doesn't set
   * them itself — the wizard has no per-run URL override UI, so without this
   * default it would silently never see those flags at all, unlike the
   * `/eval <args>` dispatch case which already threads them through. Returns
   * whether the launch actually started. */
  const launchEval = (req: TuiEvalRequest): boolean => {
    if (evalBusy.current) {
      store.addSystemMessage('an eval is already running — type /eval (no args) to watch it');
      return false;
    }
    if (store.getSnapshot().status === 'running') {
      store.addSystemMessage('a scan is running — wait for it to finish before evaluating');
      return false;
    }
    const fullReq: TuiEvalRequest = {
      staticUrl,
      dynamicUrl,
      ...req,
    };
    evalBusy.current = true;
    void runTuiEval(store, fullReq).finally(() => {
      evalBusy.current = false;
    });
    return true;
  };

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

  // ── Eval history (browse/reopen a PAST run, read-only) ──

  /** `/eval history` — overlay listing recent past runs (newest first); picking
   * one loads it read-only via loadEvalRun/loadHistoricalEval, same as
   * resolving a token directly. */
  const openEvalHistory = () => {
    const runs = listEvalRuns(resultsDir);
    if (runs.length === 0) {
      store.addSystemMessage('no past eval runs found under results/');
      return;
    }
    setOverlay({
      title: `Past eval runs (${runs.length}) — pick one to review`,
      options: runs.map((r) => ({
        label: `${r.name}`,
        value: r.dir,
        description: `${r.corpus.split('/').pop()} · ${r.mode}${r.dynamic !== 'off' ? `+${r.dynamic}` : ''} · P${(r.precision * 100).toFixed(0)} R${(r.recall * 100).toFixed(0)} F1${r.f1.toFixed(2)} · ${r.caseCount} cases`,
      })),
      onSubmit: (vals) => {
        const dir = vals[0];
        if (!dir) return;
        const loaded = loadEvalRun(dir);
        if (!loaded) {
          store.addSystemMessage(`failed to load eval run at ${dir}`);
          return;
        }
        store.loadHistoricalEval(loaded);
      },
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
        if (arg) applyMode(arg);
        else openSelect('/mode', applyMode, state.mode);
        return;

      case '/dynamic':
        if (arg) applyDynamic(arg);
        else openSelect('/dynamic', applyDynamic, state.dynamic);
        return;

      case '/preflight':
        void doPreflight(store, staticUrl, dynamicUrl);
        return;

      case '/help':
        store.addSystemMessage('── commands ──');
        for (const c of COMMANDS) {
          store.addSystemMessage(
            `  ${c.name} — ${c.summary}${c.usage ? ` (${c.usage})` : ''}`,
          );
        }
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

        // Generate and show scan plan
        const plan = generateScanPlan(arg, snap.mode, snap.dynamic);
        store.addSystemMessage('── Scan Plan ──');
        for (const step of plan.steps) {
          if (step.skipped) continue;
          const icon = step.optional ? '◻' : '■';
          store.addSystemMessage(`  ${icon} ${step.label}  ${step.detail}`);
        }

        setOverlay({
          title: `Scan this repo? · ${plan.mandatoryCount} mandatory + ${plan.optionalCount} optional steps`,
          options: [
            { label: `${glyph.tick} Approve & scan`, value: 'approve' },
            { label: `${glyph.cross} Cancel`, value: 'cancel' },
          ],
          onSubmit: (vals) => {
            if (vals[0] === 'approve') {
              void runTuiScan(store, {
                repo: arg,
                mode: snap.mode,
                dynamic: snap.dynamic,
                staticUrl,
                dynamicUrl,
              });
            }
          },
        });
        return;
      }

      case '/eval': {
        // /eval <corpus-path> [limit] [c=N] [--resume] — uses the current /mode + /dynamic
        // (legacy direct-args form, unchanged — scripting/muscle-memory path).
        // /eval with no path re-opens the dashboard ONLY while an eval is still
        // RUNNING (e.g. after Esc'ing out to check something else) — `snap.eval`
        // stays populated forever after the run finishes (it's the last result,
        // not "is one active"), so gating on it alone meant /eval could never
        // reach the wizard again once a single eval had ever run this session.
        // Once finished, bare /eval opens the wizard for a NEW run; the finished
        // run's artifacts are still on disk and reachable again via
        // `/eval history` (pick from a list) or `/eval <name>` (direct by dir name).
        const snap = store.getSnapshot();
        const tokens = rest.filter((t) => t.length > 0);

        if (tokens[0] === 'history') {
          openEvalHistory();
          return;
        }

        // corpus = first token that's not a flag, not a bare number, not c=N
        const corpus = tokens.find(
          (t) => !t.startsWith('--') && !/^\d+$/.test(t) && !/^c=\d+$/i.test(t),
        );
        if (!corpus) {
          if (snap.eval?.running) {
            store.setView('eval');
          } else if (evalBusy.current) {
            store.addSystemMessage('an eval is already running — type /eval (no args) to watch it');
          } else {
            store.setView('evalSetup');
          }
          return;
        }

        // A bare token may name a PAST run's output dir (`/eval <name>`) rather
        // than a corpus to launch fresh — check before treating it as a corpus
        // path. Unambiguous: past runs live under resultsDir with a metrics.json,
        // corpora don't.
        const historical = resolveHistoricalRun(corpus, resultsDir);
        if (historical) {
          const loaded = loadEvalRun(historical);
          if (!loaded) {
            store.addSystemMessage(`failed to load eval run at ${historical}`);
            return;
          }
          store.loadHistoricalEval(loaded);
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
        launchEval({ corpus, mode: snap.mode, dynamic: snap.dynamic, limit, concurrency, resume, staticUrl, dynamicUrl });
        return;
      }

      default:
        store.addSystemMessage(`unknown command: ${cmd} — type / to see available commands`);
    }
  };

  return { dispatch, openReport, showMetrics, openSelect, launchEval, openEvalHistory };
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
  const { loadConfig } = await import('@cleak/config');
  const cfg = loadConfig({
    ...(staticUrl ? { staticUrl } : {}),
    ...(dynamicUrl ? { dynamicUrl } : {}),
  });
  store.addSystemMessage('── preflight ──');

  // Resolve the LLM validation message synchronously
  const llm = cfg.llm;
  let syncError: string | null = null;
  if (llm.provider === 'local' || llm.provider === 'openai-compat') {
    if (!llm.baseUrl) {
      syncError = `✗ LLM ${llm.provider} — no base URL configured (set in /config or ~/.config/cleak/config.json)`;
    } else if (!llm.model) {
      syncError = `✗ LLM ${llm.provider} — no model configured (set in /config or ~/.config/cleak/config.json)`;
    }
  } else if (llm.provider === 'openai' || llm.provider === 'anthropic') {
    if (!llm.apiKey) {
      const envKey = llm.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
      syncError = `✗ LLM ${llm.provider} — no API key (set ${envKey})`;
    }
  } else {
    syncError = `✗ LLM — unknown provider "${llm.provider}"`;
  }

  if (syncError) {
    store.addSystemMessage(syncError);
  }

  const llmId = store.push({ kind: 'system', text: `○ LLM ${llm.provider}:${llm.model || '?'} — waiting…` });
  const staticId = store.push({ kind: 'system', text: `○ static ${cfg.staticUrl} — waiting…` });
  const dynamicId = store.push({ kind: 'system', text: `○ dynamic ${cfg.dynamicUrl} — waiting…` });

  const llmPromise = syncError
    ? Promise.resolve(syncError)
    : testLlmResult(store, cfg);
  const staticPromise = checkMcpResult(store, 'static', cfg.staticUrl);
  const dynamicPromise = checkMcpResult(store, 'dynamic', cfg.dynamicUrl);

  llmPromise.then((r) => store.updateMessage(llmId, (m) => ({ ...m, text: r })));
  staticPromise.then((r) => store.updateMessage(staticId, (m) => ({ ...m, text: r })));
  dynamicPromise.then((r) => store.updateMessage(dynamicId, (m) => ({ ...m, text: r })));

  await Promise.all([llmPromise, staticPromise, dynamicPromise]);
}

async function testLlmResult(store: TuiStore, cfg: RunConfig): Promise<string> {
  const { buildCallModel } = await import('@cleak/agent-core');
  const { toProviderSettings } = await import('@cleak/config');
  const provider = cfg.llm.provider;
  const model = cfg.llm.model || '?';
  const startedAt = Date.now();
  try {
    const callModel = buildCallModel(toProviderSettings(cfg), () => globalThis.crypto.randomUUID());
    const response = await callModel({
      systemPrompt: '',
      messages: [{ role: 'user', content: 'Respond with exactly one word: OK' }],
      tools: [],
      temperature: 0,
    });
    const elapsed = Date.now() - startedAt;
    const text = (response.text ?? '').trim();
    if (text.toUpperCase().includes('OK')) {
      return `✓ LLM ${provider}:${model} — responded in ${elapsed}ms`;
    }
    return `✓ LLM ${provider}:${model} — responded (${elapsed}ms, reply: "${text.slice(0, 40)}")`;
  } catch (err: any) {
    const elapsed = Date.now() - startedAt;
    return `✗ LLM ${provider}:${model} — ${err?.message ?? err} (${elapsed}ms)`;
  }
}

async function checkMcpResult(store: TuiStore, label: string, url: string): Promise<string> {
  const { McpClient } = await import('@cleak/agent-core');
  const client = new McpClient(url, label);
  try {
    const tools = await client.listTools();
    return `✓ ${label} ${url} — ${tools.length} tools`;
  } catch (err: any) {
    return `✗ ${label} ${url} — ${err?.message ?? err}`;
  } finally {
    await client.close();
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
  const { loadConfig } = await import('@cleak/config');
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
