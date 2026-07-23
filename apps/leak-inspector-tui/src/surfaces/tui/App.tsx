import { useEffect, useRef, useState } from 'react';
import { Box, useApp, useInput } from 'ink';
import { useStoreSelector } from './store/selectors';
import { appendHistory } from './history';
import { useHistoryNavigation } from './hooks/useHistoryNavigation';
import { useCommands, type Overlay } from './hooks/useCommands';
import { MainScreen } from './screens/MainScreen';
import { ConfigScreen } from './components/ConfigScreen';
import { EvalScreen } from './components/EvalScreen';
import { FindingsScreen } from './components/FindingsScreen';
import { saveConfigFile, loadConfigFile, type CleakConfig } from '../../domain/config-file';
import { visibleMessages, type TuiStore } from './store';

export interface AppProps {
  store: TuiStore; staticUrl?: string; dynamicUrl?: string;
  cwd: string; resultsDir: string; recentScans: string[];
}

export function App({ store, staticUrl, dynamicUrl, cwd, resultsDir, recentScans }: AppProps) {
  const state = useStoreSelector(store, (s) => s);
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [inputRev, setInputRev] = useState(0);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [ctrlCArmed, setCtrlCArmed] = useState(false);
  const {
    history, recallHistory, completeCommand, matches, idx, showSuggest, setSuggestIndex, resetHistoryCursor,
  } = useHistoryNavigation(input, setInput, store, overlay, setInputRev);
  const { dispatch, openReport, showMetrics, openSelect } = useCommands(
    store, exit, resultsDir, setOverlay, staticUrl, dynamicUrl,
  );

  useInput((ch, key) => {
    if (key.ctrl && (ch === 'c' || ch === '\x03')) {
      if (overlay) { setOverlay(null); return; }
      if (input) { setInput(''); setCtrlCArmed(false); return; }
      if (ctrlCArmed) { exit(); return; }
      setCtrlCArmed(true); store.addSystemMessage('Press Ctrl+C again to exit'); return;
    }
    if (ctrlCArmed) setCtrlCArmed(false);
    if (key.escape && state.view === 'main' && !overlay
      && (state.status === 'running' || state.status === 'paused') && !state.pendingPermission) store.abort();
  });

  const viewportRows = Math.max(8, (process.stdout.rows ?? 30) - 12);
  const visible = visibleMessages(state);
  const maxOffset = Math.max(0, visible.length - viewportRows);
  const page = Math.max(1, Math.floor(viewportRows / 2));
  useInput((_ch, key) => {
    if (key.pageUp) store.scrollBy(page, maxOffset);
    else if (key.pageDown) {
      if (state.scrollOffset <= page) store.scrollToBottom();
      else store.scrollBy(-page, maxOffset);
    }
  }, { isActive: state.view === 'main' && !overlay && !state.pendingPermission });

  useInput((_ch, key) => {
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
    } else if (key.downArrow && state.agents.length > 0) store.enterAgentList();
  }, { isActive: state.view === 'main' && !overlay && !state.pendingPermission && input === '' });

  const lastShownScanId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (state.autoShowReport && state.status === 'done' && state.scanId && lastShownScanId.current !== state.scanId) {
      lastShownScanId.current = state.scanId;
      openReport(state.scanId);
    }
  }, [state.status, state.scanId, state.autoShowReport]);

  useInput((_ch, key) => {
    if (matches.length === 0) return;
    if (key.downArrow) setSuggestIndex((i) => (i + 1) % matches.length);
    else if (key.upArrow) setSuggestIndex((i) => (i - 1 + matches.length) % matches.length);
    else if (key.tab && !key.shift) completeCommand(matches[idx].name);
  }, { isActive: showSuggest });

  useInput(
    (_ch, key) => { if (key.tab && key.shift) store.cyclePermissionMode(); },
    { isActive: state.view === 'main' && !overlay },
  );

  useInput((_ch, key) => {
    if (key.upArrow) recallHistory('prev');
    else if (key.downArrow) recallHistory('next');
  }, { isActive: state.view === 'main' && !overlay && !state.pendingPermission && !showSuggest && state.navMode === 'normal' });

  const handleInputChange = (v: string) => {
    setInput(v); setSuggestIndex(0); resetHistoryCursor();
    if (ctrlCArmed) setCtrlCArmed(false);
  };
  const handleInputSubmit = (raw: string) => {
    if (showSuggest && matches.length > 0 && !raw.includes(' ') && raw.trim() !== matches[idx].name) {
      completeCommand(matches[idx].name); return;
    }
    setInput(''); setSuggestIndex(0);
    const trimmed = raw.trim();
    if (trimmed) { history.current = appendHistory(history.current, trimmed); dispatch(trimmed); }
    resetHistoryCursor();
  };
  const handleOverlayCancel = () => setOverlay(null);

  const saveConfig = async (cfg: CleakConfig) => {
    let savedPath = '';
    try { savedPath = saveConfigFile(cfg); } catch (err: any) { store.addSystemMessage(`failed to save settings: ${err?.message ?? err}`); }
    const { loadConfig } = await import('../../config');
    const eff = loadConfig({});
    store.setOptions({
      mode: cfg.defaultMode ?? state.mode, dynamic: cfg.defaultDynamic ?? state.dynamic,
      provider: eff.provider, model: eff.llm.model, baseUrl: eff.llm.baseUrl, apiKey: eff.llm.apiKey,
    });
    store.setAutoShowReport(cfg.autoShowReport ?? state.autoShowReport);
    store.setView('main');
    store.addSystemMessage(
      `settings saved${savedPath ? ` → ${savedPath}` : ''} · provider ${eff.provider}${eff.llm.model ? `:${eff.llm.model}` : ''} · mode ${cfg.defaultMode ?? state.mode}, dynamic ${cfg.defaultDynamic ?? state.dynamic}, auto-report ${(cfg.autoShowReport ?? state.autoShowReport) ? 'on' : 'off'}`,
    );
  };

  if (state.view === 'config') return <Box flexDirection="column"><ConfigScreen initial={{ ...loadConfigFile(), defaultMode: state.mode, defaultDynamic: state.dynamic, autoShowReport: state.autoShowReport, provider: state.provider as CleakConfig['provider'] }} onSave={saveConfig} onCancel={() => store.setView('main')} /></Box>;
  if (state.view === 'eval' && state.eval) return <Box flexDirection="column"><EvalScreen store={store} evalState={state.eval} resultsDir={resultsDir} /></Box>;
  if (state.view === 'findings' && state.findings) return <Box flexDirection="column"><FindingsScreen store={store} state={state} resultsDir={resultsDir} /></Box>;

  return (
    <MainScreen state={state} store={store} viewportRows={viewportRows} resultsDir={resultsDir}
      recentScans={recentScans} staticUrl={staticUrl ?? 'localhost:50061/mcp'} cwd={cwd}
      input={input} inputRev={inputRev} overlay={overlay}
      showSuggest={showSuggest} matches={matches} idx={idx}
      onInputChange={handleInputChange} onInputSubmit={handleInputSubmit}
      onOverlayCancel={handleOverlayCancel} completeCommand={completeCommand}
    />
  );
}
