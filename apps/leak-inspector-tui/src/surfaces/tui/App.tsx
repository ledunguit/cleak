import { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { useStore } from './components/hooks';
import { Welcome } from './components/Welcome';
import { MessageList } from './components/MessageList';
import { AgentList } from './components/AgentList';
import { PhaseTimeline } from './components/PhaseTimeline';
import { Footer } from './components/Footer';
import { Spinner } from './components/Spinner';
import { PromptInput } from './components/PromptInput';
import { PermissionPrompt } from './components/PermissionPrompt';
import { Select, type SelectOption } from './components/Select';
import { CommandSuggestions } from './components/CommandSuggestions';
import { ConfigScreen } from './components/ConfigScreen';
import { EvalScreen } from './components/EvalScreen';
import { FindingsScreen } from './components/FindingsScreen';
import { snapshotFindingToView } from './findings/findingView';
import { COMMANDS, matchCommands, findCommand } from './commands';
import { loadHistory, appendHistory, historyStep } from './history';
import { color, glyph, formatDuration } from './theme';
import { savePreferences, loadPreferences, type UserPreferences } from './preferences';
import { runTuiScan } from './runner';
import { runTuiEval } from './evalRunner';
import { visibleMessages, type TuiStore } from './store';

export interface AppProps {
  store: TuiStore;
  staticUrl?: string;
  dynamicUrl?: string;
  cwd: string;
  resultsDir: string;
  recentScans: string[];
}

interface Overlay {
  title: string;
  options: SelectOption[];
  multi?: boolean;
  onSubmit: (values: string[]) => void;
}

export function App({ store, staticUrl, dynamicUrl, cwd, resultsDir, recentScans }: AppProps) {
  const state = useStore(store);
  const { exit } = useApp();

  const [input, setInput] = useState('');
  const [inputRev, setInputRev] = useState(0);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [ctrlCArmed, setCtrlCArmed] = useState(false);

  // ── Prompt history (shell-style ↑/↓, persisted across sessions) ──
  // `histIndex === -1` is the live draft; `histDraft` stashes it on the first ↑.
  const history = useRef<string[]>(loadHistory());
  const histIndex = useRef(-1);
  const histDraft = useRef('');
  const recallHistory = (dir: 'prev' | 'next') => {
    if (dir === 'prev' && histIndex.current === -1) histDraft.current = input;
    const r = historyStep(history.current, histIndex.current, histDraft.current, dir);
    if (r.index === histIndex.current) return; // no movement (e.g. ↓ at the live draft) — let other handlers act
    histIndex.current = r.index;
    setInput(r.value);
    setSuggestIndex(0);
    setInputRev((x) => x + 1); // snap the input cursor to the end of the recalled line
  };

  const showSuggest = input.startsWith('/') && !overlay;
  const matches = showSuggest ? matchCommands(input) : [];
  const idx = Math.min(suggestIndex, Math.max(0, matches.length - 1));

  // Drop the highlighted command into the input with the cursor at the end (Tab /
  // first Enter). Bumping inputRev remounts the TextInput so its cursor re-inits
  // to value.length instead of staying mid-string.
  const completeCommand = (name: string) => {
    setInput(`${name} `);
    setSuggestIndex(0);
    setInputRev((r) => r + 1);
  };

  // ── Global keys: Ctrl+C (clear → confirm-exit) and ESC (interrupt / cancel overlay) ──
  useInput((ch, key) => {
    if (key.ctrl && (ch === 'c' || ch === '')) {
      if (overlay) {
        setOverlay(null);
      } else if (input) {
        setInput('');
        setCtrlCArmed(false);
      } else if (ctrlCArmed) {
        exit();
      } else {
        setCtrlCArmed(true);
        store.addSystemMessage('Press Ctrl+C again to exit');
      }
      return;
    }
    if (ctrlCArmed) setCtrlCArmed(false);
    if (
      key.escape &&
      state.view === 'main' &&
      !overlay &&
      (state.status === 'running' || state.status === 'paused') &&
      !state.pendingPermission
    ) {
      store.abort();
    }
  });

  // ── Log scrolling: PageUp/PageDown only — never part of typed text, so it's safe
  // to keep active while the prompt has focus (Ink delivers keys to all handlers). ──
  const viewportRows = Math.max(8, (process.stdout.rows ?? 30) - 12);
  const visible = visibleMessages(state);
  const maxOffset = Math.max(0, visible.length - viewportRows);
  const page = Math.max(1, Math.floor(viewportRows / 2));
  useInput(
    (_ch, key) => {
      if (key.pageUp) store.scrollBy(page, maxOffset);
      else if (key.pageDown) {
        // PageDown at the bottom snaps fully back to live.
        if (state.scrollOffset <= page) store.scrollToBottom();
        else store.scrollBy(-page, maxOffset);
      }
    },
    { isActive: state.view === 'main' && !overlay && !state.pendingPermission },
  );

  // ── Modal agent navigation (active only when the prompt is empty, so it never
  // fights typing): ↓ from main drops into the agent list; in the list ↑/↓ choose,
  // enter opens an agent's log; inside a log ↑/↓ move the focus cursor, enter
  // expands/collapses the focused thinking/tool line, ← returns to the main flow. ──
  useInput(
    (_ch, key) => {
      if (state.navMode === 'agentlog') {
        if (key.leftArrow) store.backToMain();
        else if (key.upArrow) store.logFocusMove(-1, viewportRows);
        else if (key.downArrow) store.logFocusMove(1, viewportRows);
        else if (key.return) store.toggleFocusedCollapse();
      } else if (state.navMode === 'agentlist') {
        if (key.leftArrow || key.escape) store.backToMain();
        else if (key.upArrow) store.navMove(-1);
        else if (key.downArrow) store.navMove(1);
        else if (key.return) store.openFocusedAgent();
      } else {
        // normal main flow: ↓ drops into the agent list (if any sub-agents)
        if (key.downArrow && state.agents.length > 0) store.enterAgentList();
      }
    },
    { isActive: state.view === 'main' && !overlay && !state.pendingPermission && input === '' },
  );

  // ── Auto-show the report when a scan finishes (if enabled in /config) ──
  const lastShownScanId = useRef<string | undefined>(undefined);
  const evalBusy = useRef(false);
  useEffect(() => {
    if (
      state.autoShowReport &&
      state.status === 'done' &&
      state.scanId &&
      lastShownScanId.current !== state.scanId
    ) {
      lastShownScanId.current = state.scanId;
      openReport(state.scanId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.scanId, state.autoShowReport]);

  // ── Suggestion navigation: ↑/↓ to choose, Tab to complete (text-input ignores these keys) ──
  useInput(
    (_ch, key) => {
      if (matches.length === 0) return;
      if (key.downArrow) setSuggestIndex((i) => (i + 1) % matches.length);
      else if (key.upArrow) setSuggestIndex((i) => (i - 1 + matches.length) % matches.length);
      else if (key.tab && !key.shift) completeCommand(matches[idx].name); // Shift+Tab toggles permission mode, never completes
    },
    { isActive: showSuggest },
  );

  // ── Shift+Tab: toggle Ask ↔ Auto-accept for heavy tools (always available on the main view) ──
  useInput(
    (_ch, key) => {
      if (key.tab && key.shift) store.cyclePermissionMode();
    },
    { isActive: state.view === 'main' && !overlay },
  );

  // ── Prompt history: ↑ recalls older prompts, ↓ steps back toward the live draft.
  // Gated so it never fights command suggestions or agent-list navigation; at the
  // live empty draft ↓ is a no-op, so the agent-list drop (below) still fires. ──
  useInput(
    (_ch, key) => {
      if (key.upArrow) recallHistory('prev');
      else if (key.downArrow) recallHistory('next');
    },
    {
      isActive:
        state.view === 'main' &&
        !overlay &&
        !state.pendingPermission &&
        !showSuggest &&
        state.navMode === 'normal',
    },
  );

  // ── Option appliers (shared by typed-arg and the select overlay) ──
  const applyMode = (v: string) => {
    if (v === 'no_llm' || v === 'llm_assisted') {
      store.setOptions({ mode: v });
      store.addSystemMessage(`mode = ${v}${state.status === 'running' ? ' (applies to the next scan)' : ''}`);
    } else store.addSystemMessage('usage: /mode no_llm|llm_assisted');
  };
  const applyDynamic = (v: string) => {
    if (v === 'off' || v === 'selective' || v === 'aggressive') {
      store.setOptions({ dynamic: v });
      store.addSystemMessage(`dynamic = ${v}${state.status === 'running' ? ' (applies to the next scan)' : ''}`);
    } else store.addSystemMessage('usage: /dynamic off|selective|aggressive');
  };
  const openSelect = (cmd: string, apply: (v: string) => void, initial?: string) => {
    const spec = findCommand(cmd);
    if (!spec?.options) return;
    setOverlay({
      title: `${cmd} ${glyph.bullet} choose`,
      options: spec.options.map((o) => ({ ...o, color: o.value === initial ? color.accent : undefined })),
      onSubmit: (vals) => apply(vals[0]),
    });
  };

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

  const dispatch = (raw: string) => {
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
          store.addSystemMessage('a scan is running — press ESC to interrupt, or type a message to steer the agent');
          return;
        }
        if (!arg) {
          store.addSystemMessage('usage: /scan <repo-path>');
          return;
        }
        store.addUserMessage(`/scan ${arg} (mode ${snap.mode}, dynamic ${snap.dynamic})`);
        void runTuiScan(store, { repo: arg, mode: snap.mode, dynamic: snap.dynamic, staticUrl, dynamicUrl });
        return;
      }
      case '/eval': {
        // /eval <corpus-path> [limit] [c=N] [--resume] — uses the current /mode + /dynamic.
        // /eval with no path re-opens the live/last dashboard (e.g. after Esc'ing out).
        const snap = store.getSnapshot();
        const tokens = rest.filter((t) => t.length > 0);
        // corpus = first token that's not a flag, not a bare number, not c=N
        const corpus = tokens.find((t) => !t.startsWith('--') && !/^\d+$/.test(t) && !/^c=\d+$/i.test(t));
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
        void runTuiEval(store, { corpus, mode: snap.mode, dynamic: snap.dynamic, limit, concurrency, resume, staticUrl, dynamicUrl })
          .finally(() => {
            evalBusy.current = false;
          });
        return;
      }
      default:
        store.addSystemMessage(`unknown command: ${cmd} — type / to see available commands`);
    }
  };

  const submit = (raw: string) => {
    // Still typing a command name with a suggestion highlighted? Enter completes
    // it into the input (like Tab) rather than submitting, so you can add an arg.
    if (showSuggest && matches.length > 0 && !raw.includes(' ') && raw.trim() !== matches[idx].name) {
      completeCommand(matches[idx].name);
      return;
    }
    setInput('');
    setSuggestIndex(0);
    const trimmed = raw.trim();
    if (trimmed) {
      history.current = appendHistory(history.current, trimmed);
      dispatch(trimmed);
    }
    histIndex.current = -1;
    histDraft.current = '';
  };

  const saveConfig = async (prefs: UserPreferences) => {
    let savedPath = '';
    try {
      savedPath = savePreferences(prefs);
    } catch (err: any) {
      store.addSystemMessage(`failed to save settings: ${err?.message ?? err}`);
    }
    // Resolve the chosen provider + its endpoint override so the next scan this
    // session (and the footer/welcome) reflect the change without a restart.
    const { loadConfig } = await import('../../config');
    const provider = prefs.defaultProvider;
    const ep = (provider && prefs.endpoints?.[provider]) || {};
    const nz = (s?: string) => (s && s.trim() ? s : undefined);
    const cfg = loadConfig({ provider, llm: { baseUrl: nz(ep.baseUrl), model: nz(ep.model), apiKey: nz(ep.apiKey) } });
    store.setOptions({
      mode: prefs.defaultMode,
      dynamic: prefs.defaultDynamic,
      provider: cfg.provider,
      model: cfg.llm.model,
      baseUrl: cfg.llm.baseUrl,
      apiKey: cfg.llm.apiKey,
    });
    store.setAutoShowReport(prefs.autoShowReport);
    store.setView('main');
    store.addSystemMessage(
      `settings saved${savedPath ? ` → ${savedPath}` : ''} · provider ${cfg.provider}${cfg.llm.model ? `:${cfg.llm.model}` : ''} · mode ${prefs.defaultMode}, dynamic ${prefs.defaultDynamic}, auto-report ${prefs.autoShowReport ? 'on' : 'off'}`,
    );
  };

  if (state.view === 'config') {
    return (
      <Box flexDirection="column">
        <ConfigScreen
          initial={{
            // Persisted prefs (carry the per-provider `endpoints` map) overlaid with
            // the live session values for the simple toggles + active provider.
            ...loadPreferences(),
            defaultMode: state.mode,
            defaultDynamic: state.dynamic,
            autoShowReport: state.autoShowReport,
            defaultProvider: state.provider as UserPreferences['defaultProvider'],
          }}
          onSave={saveConfig}
          onCancel={() => store.setView('main')}
        />
      </Box>
    );
  }

  if (state.view === 'eval' && state.eval) {
    return (
      <Box flexDirection="column">
        <EvalScreen store={store} evalState={state.eval} resultsDir={resultsDir} />
      </Box>
    );
  }

  if (state.view === 'findings' && state.findings) {
    return (
      <Box flexDirection="column">
        <FindingsScreen store={store} state={state} resultsDir={resultsDir} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Welcome
        provider={state.provider}
        model={state.model}
        staticUrl={staticUrl ?? 'localhost:50061/mcp'}
        cwd={cwd}
        recentScans={recentScans}
      />

      {state.viewAgentId !== 'main' ? (
        <Box marginTop={1}>
          <Text color={color.accent}>
            ▸ {state.agents.find((a) => a.id === state.viewAgentId)?.label ?? state.viewAgentId} log
          </Text>
          <Text dimColor> {glyph.bullet} ↑/↓ focus · enter expand/collapse · ← back to main</Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        <MessageList messages={visible} scrollOffset={state.scrollOffset} viewportRows={viewportRows} focusMsgId={state.focusMsgId} />
      </Box>

      {state.status === 'running' ? (
        <Box marginTop={1}>
          <Spinner label={state.statusText} startedAt={state.startedAt} usage={state.usage} io={state.io} />
        </Box>
      ) : null}

      {state.status === 'paused' ? (
        <Box marginTop={1}>
          <Text color={color.warning} bold>
            ⏸ {state.statusText}
          </Text>
        </Box>
      ) : null}

      {state.summary && state.status === 'done' ? (
        <Box marginTop={1}>
          <Text>
            <Text color={color.success}>{glyph.mark} </Text>
            <Text>
              {state.summary.candidates} candidates {glyph.bullet}{' '}
              <Text color={color.error}>{state.summary.confirmed} confirmed</Text> {glyph.bullet}{' '}
              <Text color={color.warning}>{state.summary.likely} likely</Text>
            </Text>
            {state.reportDir ? <Text dimColor> {glyph.bullet} {state.reportDir}</Text> : null}
            <Text dimColor> {glyph.bullet} /report to browse findings</Text>
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <PhaseTimeline phases={state.phases} />
      </Box>

      {state.pendingPermission ? (
        <Box marginTop={1}>
          <PermissionPrompt pending={state.pendingPermission} />
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        {overlay ? (
          <Select
            title={overlay.title}
            options={overlay.options}
            multi={overlay.multi}
            onSubmit={(vals) => {
              const o = overlay;
              setOverlay(null);
              o.onSubmit(vals);
            }}
            onCancel={() => setOverlay(null)}
          />
        ) : (
          <>
            <PromptInput
              rev={inputRev}
              disabled={!!state.pendingPermission}
              running={state.status === 'running'}
              paused={state.status === 'paused'}
              mode={state.mode}
              value={input}
              onChange={(v) => {
                setInput(v);
                setSuggestIndex(0);
                histIndex.current = -1; // typing forks off any recalled history entry
                if (ctrlCArmed) setCtrlCArmed(false);
              }}
              onSubmit={submit}
            />
            {showSuggest ? <CommandSuggestions commands={matches} index={idx} /> : null}
            <AgentList state={state} />
            <Footer state={state} />
          </>
        )}
      </Box>
    </Box>
  );
}

/** Show the descriptive metrics for a scan (results/<id>/metrics.json). */
function showMetrics(store: TuiStore, resultsDir: string, scanId?: string): void {
  const id = scanId ?? mostRecentScanId(resultsDir);
  if (!id) return store.addSystemMessage('no scans yet');
  const path = join(resultsDir, id, 'metrics.json');
  if (!existsSync(path)) return store.addSystemMessage(`no metrics for "${id}" (re-run the scan to generate it)`);
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
  store.addSystemMessage(`  mode: ${m.mode}${m.dynamic !== 'off' ? ` +dynamic(${m.dynamic})` : ''} · candidates: ${m.candidates} · ${m.confirmed} confirmed / ${m.likely} likely`);
  if (verdicts) store.addSystemMessage(`  verdicts: ${verdicts}`);
  store.addSystemMessage(`  confidence: mean ${(m.confidence?.mean ?? 0).toFixed(2)} (min ${(m.confidence?.min ?? 0).toFixed(2)}, max ${(m.confidence?.max ?? 0).toFixed(2)})`);
  if (roots) store.addSystemMessage(`  root causes: ${roots}`);
  store.addSystemMessage(`  evidence: ${m.evidence_count ?? 0} · tools: ${(m.tools_used ?? []).join(', ') || 'none'}`);
  store.addSystemMessage(`  cost: ${m.turns ?? '?'} turns · ${m.total_tokens ?? 0} tokens · ${m.duration_ms != null ? formatDuration(m.duration_ms) : '?'}`);
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
  const { loadConfig } = await import('../../config');
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
  const { loadConfig } = await import('../../config');
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
