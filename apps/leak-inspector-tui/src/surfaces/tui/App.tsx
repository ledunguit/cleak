import { useEffect, useInsertionEffect, useRef, useState } from 'react';
import { Box, useApp, useInput } from 'ink';
import { useStore } from 'zustand';
import { appendHistory } from './history';
import { useHistoryNavigation } from './hooks/useHistoryNavigation';
import { SuggestionListHandle } from './components/SuggestionList';
import { useCommands, type Overlay } from './hooks/useCommands';
import { MainScreen } from './screens/MainScreen';
import { ConfigScreen } from './components/ConfigScreen';
import { EvalScreen } from './components/EvalScreen';
import { EvalSetupScreen } from './components/EvalSetupScreen';
import { FindingsScreen } from './components/FindingsScreen';
import { saveConfigFile, loadConfigFile, configTemplate, type CleakConfig } from '@cleak/config';
import { visibleMessages, type TuiStore } from '../../stores';
import { scanStore } from '../../stores/scan-store';
import { configStore } from '../../stores/config-store';
import { useTerminalSize } from './hooks/useTerminalSize';
import { useViewportRows } from './hooks/useViewportRows';
import { totalMessageLines } from './components/messageLines';

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
  const { columns: termCols } = useTerminalSize();
  const viewportRows = useViewportRows();

  // Use alternate screen buffer for ALL views to keep header/footer sticky.
  // Without this, the terminal scrolls naturally when content exceeds rows,
  // pushing the header off-screen.
  //
  // CRITICAL: useInsertionEffect (not useEffect) so the alt-screen is entered
  // BEFORE Ink paints the first frame — avoids the blank-screen-until-keypress
  // bug and the flash-of-main-screen flicker on view transitions.
  // Use process.stdout directly (not useStdout()) to avoid re-triggering on
  // resize/state changes — process.stdout is a stable singleton.
  useInsertionEffect(() => {
    process.stdout.write('\x1b[?1049h'); // enter alternate screen
    return () => { process.stdout.write('\x1b[?1049l'); }; // leave alternate screen
  }, [view]);
  const [input, setInput] = useState('');
  const [inputRev, setInputRev] = useState(0);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [ctrlCArmed, setCtrlCArmed] = useState(false);
  const suggestRef = useRef<SuggestionListHandle>(null);
  const {
    history, recallHistory, completeCommand, matches, showSuggest, resetHistoryCursor,
  } = useHistoryNavigation(input, setInput, store, overlay, setInputRev);
  const { dispatch, openReport, launchEval, openEvalHistory } = useCommands(
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

  // Reactive terminal dimensions via useTerminalSize() — updates on resize.
  // MainLayout clips content via flexGrow+overflow:hidden, so this is only
  // used for scroll offset math, not for actual rendering. The offset is
  // measured in LINES (windowMessages does the same), so multi-line messages
  // scroll correctly.
  const visible = visibleMessages(fullState);
  const maxOffset = Math.max(0, totalMessageLines(visible, termCols) - viewportRows);
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
    try {
      // saveConfigFile with fillDefaults merges cfg on top of configTemplate() +
      // existing file data — guaranteeing ALL keys are present even if the
      // in-memory draft is partial.
      savedPath = saveConfigFile(cfg as Record<string, unknown>, { fillDefaults: true });
    } catch (err: any) { scanStore.getState().addSystemMessage(`failed to save settings: ${err?.message ?? err}`); }
    const { loadConfig } = await import('@cleak/config');
    const eff = loadConfig({});
    configStore.getState().setOptions({
      mode: cfg.defaultMode ?? fullState.mode, dynamic: cfg.defaultDynamic ?? fullState.dynamic,
      provider: eff.provider, model: eff.llm.model, baseUrl: eff.llm.baseUrl, apiKey: eff.llm.apiKey,
    });
    configStore.getState().setAutoShowReport(cfg.autoShowReport ?? fullState.autoShowReport);
    configStore.getState().setFullscreen(cfg.fullscreen ?? fullState.fullscreen);
    configStore.getState().setSidebarPosition(cfg.sidebarPosition ?? fullState.sidebarPosition);
    store.setView('main');
    scanStore.getState().addSystemMessage(
      `settings saved${savedPath ? ` → ${savedPath}` : ''} · provider ${eff.provider}${eff.llm.model ? `:${eff.llm.model}` : ''} · mode ${cfg.defaultMode ?? fullState.mode}, dynamic ${cfg.defaultDynamic ?? fullState.dynamic}`,
    );
  };

  if (view === 'config') return <Box flexDirection="column"><ConfigScreen initial={{ ...configTemplate(), ...loadConfigFile(), defaultMode: fullState.mode, defaultDynamic: fullState.dynamic, autoShowReport: fullState.autoShowReport, fullscreen: fullState.fullscreen, sidebarPosition: fullState.sidebarPosition, provider: fullState.provider as CleakConfig['provider'] }} onSave={saveConfig} onCancel={() => store.setView('main')} /></Box>;
  if (view === 'evalSetup') return <Box flexDirection="column"><EvalSetupScreen store={store} launchEval={launchEval} onCancel={() => store.setView('main')} /></Box>;
  if (view === 'eval' && fullState.eval) return <Box flexDirection="column"><EvalScreen store={store} evalState={fullState.eval} resultsDir={resultsDir} onBackToHistory={openEvalHistory} /></Box>;
  if (view === 'findings' && fullState.findings) return <Box flexDirection="column"><FindingsScreen store={store} state={fullState} resultsDir={resultsDir} /></Box>;

  return (
    <MainScreen store={store} resultsDir={resultsDir}
      recentScans={recentScans} staticUrl={staticUrl ?? 'localhost:50061/mcp'} cwd={cwd}
      input={input} inputRev={inputRev} overlay={overlay} suggestRef={suggestRef}
      showSuggest={showSuggest} matches={matches}
      onInputChange={handleInputChange} onInputSubmit={handleInputSubmit}
      onOverlayCancel={handleOverlayCancel} completeCommand={completeCommand}
    />
  );
}
