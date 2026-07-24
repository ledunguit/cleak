/**
 * MainScreen — subscribes directly to the store for the fields it renders.
 *
 * Receives the `store` ref and non-store props; reads all slice values via
 * internal `useStoreSelector` calls so re-renders are driven by the specific
 * fields this screen displays — not by unrelated store changes in App.tsx.
 */

import { Box, Text } from 'ink';
import { memo } from 'react';
import { useStore } from 'zustand';
import { navigationStore, visibleMessages } from '../../../stores/navigation-store';
import { scanStore } from '../../../stores/scan-store';
import { configStore } from '../../../stores/config-store';
import { Welcome } from '../components/Welcome';
import { MessageList } from '../components/MessageList';
import { Spinner } from '../components/Spinner';
import { PhaseTimeline } from '../components/PhaseTimeline';
import { PermissionPrompt } from '../components/PermissionPrompt';
import { Select } from '../components/Select';
import { PromptInput } from '../components/PromptInput/index';
import { SuggestionList, type SuggestionListHandle } from '../components/SuggestionList';
import { AgentList } from '../components/AgentList';
import { Footer } from '../components/Footer';
import { FullscreenLayout } from '../layout/FullscreenLayout';
import { color, glyph } from '../theme';
import { type TuiStore, type UiState } from '../../../stores';
import type { CommandSpec } from '../commands';
import type { Overlay } from '../hooks/useCommands';

export interface MainScreenProps {
  store: TuiStore;
  viewportRows: number;
  resultsDir: string;
  recentScans: string[];
  staticUrl: string;
  cwd: string;
  input: string;
  inputRev: number;
  overlay: Overlay | null;
  showSuggest: boolean;
  matches: CommandSpec[];
  suggestRef: React.RefObject<SuggestionListHandle | null>;
  onInputChange: (value: string) => void;
  onInputSubmit: (value: string) => void;
  onOverlayCancel: () => void;
  completeCommand: (name: string) => void;
}

export const MainScreen = memo(function MainScreen({
  store,
  viewportRows,
  resultsDir,
  recentScans,
  staticUrl,
  cwd,
  input,
  inputRev,
  overlay,
  showSuggest,
  matches,
  suggestRef,
  onInputChange,
  onInputSubmit,
  onOverlayCancel,
  completeCommand,
}: MainScreenProps) {
  // Individual primitive-returning selectors to prevent infinite re-render
  // loops. An inline object selector (s => ({...})) creates a new reference
  // on every call, causing useSyncExternalStore to always detect a "change".
  // Scan fields from Zustand scanStore
  const messages = useStore(scanStore, (s) => s.messages);
  const agents = useStore(scanStore, (s) => s.agents);
  const scrollOffset = useStore(scanStore, (s) => s.scrollOffset);
  const focusMsgId = useStore(scanStore, (s) => s.focusMsgId);
  const status = useStore(scanStore, (s) => s.status);
  const statusText = useStore(scanStore, (s) => s.statusText);
  const startedAt = useStore(scanStore, (s) => s.startedAt);
  const usage = useStore(scanStore, (s) => s.usage);
  const io = useStore(scanStore, (s) => s.io);
  const summary = useStore(scanStore, (s) => s.summary);
  const reportDir = useStore(scanStore, (s) => s.reportDir);
  const phases = useStore(scanStore, (s) => s.phases);
  const currentPhase = useStore(scanStore, (s) => s.currentPhase);
  // Config fields from Zustand configStore
  const provider = useStore(configStore, (s) => s.provider);
  const model = useStore(configStore, (s) => s.model);
  const pendingPermission = useStore(configStore, (s) => s.pendingPermission);
  const mode = useStore(configStore, (s) => s.mode);
  const permissionMode = useStore(configStore, (s) => s.permissionMode);
  const dynamic = useStore(configStore, (s) => s.dynamic);
  // Fields still on legacy TuiStore (not yet migrated to Zustand)
  const viewAgentId = useStore(store, (s) => s.viewAgentId);
  const navIndex = useStore(store, (s) => s.navIndex);
  const navMode = useStore(navigationStore, (s) => s.navMode);
  const state: UiState = {
    messages, provider, model, viewAgentId, agents, scrollOffset, focusMsgId,
    status, statusText, startedAt, usage, io, summary, reportDir, phases,
    pendingPermission, mode, permissionMode, dynamic, currentPhase, navMode, navIndex,
  } as unknown as UiState;
  const visible = visibleMessages(messages, viewAgentId);

  const header = (
    <>
      <Welcome
        provider={state.provider}
        model={state.model}
        staticUrl={staticUrl}
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
    </>
  );

  const scrollable = (
    <Box flexDirection="column" marginTop={1}>
      <MessageList
        messages={visible}
        scrollOffset={state.scrollOffset}
        viewportRows={viewportRows}
        focusMsgId={state.focusMsgId}
      />
    </Box>
  );

  const bottom = (
    <>
      {state.status === 'running' ? (
        <Box marginTop={1}>
          <Spinner
            label={state.statusText}
            startedAt={state.startedAt}
            usage={state.usage}
            io={state.io}
          />
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
              <Text color={color.error}>{state.summary.confirmed} confirmed</Text>{' '}
              {glyph.bullet}{' '}
              <Text color={color.warning}>{state.summary.likely} likely</Text>
            </Text>
            {state.reportDir ? (
              <Text dimColor> {glyph.bullet} {state.reportDir}</Text>
            ) : null}
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
              onOverlayCancel();
              o.onSubmit(vals);
            }}
            onCancel={onOverlayCancel}
          />
        ) : (
          <>
            {showSuggest ? (
              <SuggestionList
                ref={suggestRef}
                commands={matches}
                showSuggest={showSuggest}
              />
            ) : null}
            <PromptInput
              rev={inputRev}
              disabled={!!state.pendingPermission}
              running={state.status === 'running'}
              paused={state.status === 'paused'}
              mode={state.mode}
              value={input}
              onChange={onInputChange}
              onSubmit={onInputSubmit}
            />
            <AgentList state={state} />
            <Footer state={state} />
          </>
        )}
      </Box>
    </>
  );

  return (
    <FullscreenLayout
      header={header}
      scrollable={scrollable}
      bottom={bottom}
    />
  );
});
