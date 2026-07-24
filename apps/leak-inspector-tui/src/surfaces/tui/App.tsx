import { useEffect, useRef, useState } from 'react';
import { Box, useApp, useInput } from 'ink';
import { useStore } from 'zustand';
import { appendHistory } from './history';
import { useHistoryNavigation } from './hooks/useHistoryNavigation';
import { SuggestionListHandle } from './components/SuggestionList';
import { useCommands, type Overlay } from './hooks/useCommands';
import { MainScreen } from './screens/MainScreen';
import { ConfigScreen } from './components/ConfigScreen';
import { EvalScreen } from './components/EvalScreen';
import { FindingsScreen } from './components/FindingsScreen';
import { saveConfigFile, loadConfigFile, type CleakConfig } from '../../domain/config-file';
import { visibleMessages, type TuiStore } from '../../stores';
import { navigationStore } from '../../stores/navigation-store';
import { scanStore } from '../../stores/scan-store';
import { configStore } from '../../stores/config-store';

export interface AppProps {
  store: TuiStore; staticUrl?: string; dynamicUrl?: string;
  cwd: string; resultsDir: string; recentScans: string[];
}

export function App({ store, staticUrl, dynamicUrl, cwd, resultsDir, recentScans }: AppProps) {
  const view = useStore(store, (s) => s.view);
  const status = useStore(store, (s) => s.status);
  const scrollOffset = useStore(store, (s) => s.scrollOffset);
  const fullState = useStore(store, (s) => s);
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [inputRev, setInputRev] = useState(0);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [ctrlCArmed, setCtrlCArmed] = useState(false);
  const suggestRef = useRef<SuggestionListHandle>(null);
  const {
    history, recallHistory, completeCommand, matches, showSuggest, resetHistoryCursor,
  } = useHistoryNavigation(input, setInput, store, overlay, setInputRev);
  const { dispatch, openReport, showMetrics, openSelect } = useCommands(
    store, exit, resultsDir, setOverlay, staticUrl, dynamicUrl,
  );

  useInput((ch, key) => {
    if (key.ctrl && (ch === 'c' || ch === '\x03')) {
      if (overlay) { setOverlay(null); return; }
      if (input) { setInput(''); setCtrlCArmed(false); return; }
      if (ctrlCArmed) { exit(); return; }
      setCtrlCArmed(true); scanStore.getState().addSystemMessage('Press Ctrl+C again to exit'); return;
    }
    if (ctrlCArmed) setCtrlCArmed(false);
    if (key.escape && view === 'main' && !overlay
      && (status === 'running' || status === 'paused') && !fullState.pendingPermission) scanStore.getState().abort();
  });

  const viewportRows = Math.max(8, (process.stdout.rows ?? 30) - 12);
  const visible = visibleMessages(fullState);
  const maxOffset = Math.max(0, visible.length - viewportRows);
  const page = Math.max(1, Math.floor(viewportRows / 2));
  useInput((_ch, key) => {
    if (key.pageUp) store.scrollBy(page, maxOffset);
    else if (key.pageDown) {
      if (scrollOffset <= page) store.scrollToBottom();
      else store.scrollBy(-page, maxOffset);
    }
  }, { isActive: view === 'main' && !overlay && !fullState.pendingPermission });

  useInput((_ch, key) => {
    if (fullState.navMode === 'agentlog') {
      if (key.leftArrow) store.backToMain();
      else if (key.upArrow) store.logFocusMove(-1, viewportRows);
      else if (key.downArrow) store.logFocusMove(1, viewportRows);
      else if (key.return) store.toggleFocusedCollapse();
    } else if (fullState.navMode === 'agentlist') {
      if (key.leftArrow || key.escape) store.backToMain();
      else if (key.upArrow) store.navMove(-1);
      else if (key.downArrow) store.navMove(1);
      else if (key.return) store.openFocusedAgent();
    } else if (key.downArrow && fullState.agents.length > 0) store.enterAgentList();
  }, { isActive: view === 'main' && !overlay && !fullState.pendingPermission && input === '' });

  const lastShownScanId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (fullState.autoShowReport && status === 'done' && fullState.scanId && lastShownScanId.current !== fullState.scanId) {
      lastShownScanId.current = fullState.scanId;
      openReport(fullState.scanId);
    }
  }, [status, fullState.scanId, fullState.autoShowReport]);

  useInput((_ch, key) => {
    if (matches.length === 0) return;
    if (key.downArrow) suggestRef.current?.navigate(1);
    else if (key.upArrow) suggestRef.current?.navigate(-1);
    else if (key.tab && !key.shift) {
      const name = matches[suggestRef.current?.selectedIndex ?? 0]?.name;
      if (name) completeCommand(name);
    }
  }, { isActive: showSuggest });

  useInput(
    (_ch, key) => {     if (key.tab && key.shift) configStore.getState().cyclePermissionMode(); },
    { isActive: view === 'main' && !overlay },
  );

  useInput((_ch, key) => {
    if (key.upArrow) recallHistory('prev');
    else if (key.downArrow) recallHistory('next');
  }, { isActive: view === 'main' && !overlay && !fullState.pendingPermission && !showSuggest && fullState.navMode === 'normal' });

  const handleInputChange = (v: string) => {
    setInput(v); resetHistoryCursor();
    if (ctrlCArmed) setCtrlCArmed(false);
  };
  const handleInputSubmit = (raw: string) => {
    if (showSuggest && matches.length > 0 && !raw.includes(' ') && raw.trim() !== matches[suggestRef.current?.selectedIndex ?? 0]?.name) {
      completeCommand(matches[suggestRef.current?.selectedIndex ?? 0].name); return;
    }
    setInput('');
    const trimmed = raw.trim();
    if (trimmed) { history.current = appendHistory(history.current, trimmed); dispatch(trimmed); }
    resetHistoryCursor();
  };
  const handleOverlayCancel = () => setOverlay(null);

  const saveConfig = async (cfg: CleakConfig) => {
    let savedPath = '';
    try { savedPath = saveConfigFile(cfg); } catch (err: any) { scanStore.getState().addSystemMessage(`failed to save settings: ${err?.message ?? err}`); }
    const { loadConfig } = await import('../../config');
    const eff = loadConfig({});
    configStore.getState().setOptions({
      mode: cfg.defaultMode ?? fullState.mode, dynamic: cfg.defaultDynamic ?? fullState.dynamic,
      provider: eff.provider, model: eff.llm.model, baseUrl: eff.llm.baseUrl, apiKey: eff.llm.apiKey,
    });
    configStore.getState().setAutoShowReport(cfg.autoShowReport ?? fullState.autoShowReport);
    navigationStore.getState().setView('main');
    scanStore.getState().addSystemMessage(
      `settings saved${savedPath ? ` → ${savedPath}` : ''} · provider ${eff.provider}${eff.llm.model ? `:${eff.llm.model}` : ''} · mode ${cfg.defaultMode ?? fullState.mode}, dynamic ${cfg.defaultDynamic ?? fullState.dynamic}, auto-report ${(cfg.autoShowReport ?? fullState.autoShowReport) ? 'on' : 'off'}`,
    );
  };

  if (view === 'config') return <Box flexDirection="column"><ConfigScreen initial={{ ...loadConfigFile(), defaultMode: fullState.mode, defaultDynamic: fullState.dynamic, autoShowReport: fullState.autoShowReport, provider: fullState.provider as CleakConfig['provider'] }} onSave={saveConfig} onCancel={() => navigationStore.getState().setView('main')} /></Box>;
  if (view === 'eval' && fullState.eval) return <Box flexDirection="column"><EvalScreen store={store} evalState={fullState.eval} resultsDir={resultsDir} /></Box>;
  if (view === 'findings' && fullState.findings) return <Box flexDirection="column"><FindingsScreen store={store} state={fullState} resultsDir={resultsDir} /></Box>;

  return (
    <MainScreen store={store} viewportRows={viewportRows} resultsDir={resultsDir}
      recentScans={recentScans} staticUrl={staticUrl ?? 'localhost:50061/mcp'} cwd={cwd}
      input={input} inputRev={inputRev} overlay={overlay} suggestRef={suggestRef}
      showSuggest={showSuggest} matches={matches}
      onInputChange={handleInputChange} onInputSubmit={handleInputSubmit}
      onOverlayCancel={handleOverlayCancel} completeCommand={completeCommand}
    />
  );
}
