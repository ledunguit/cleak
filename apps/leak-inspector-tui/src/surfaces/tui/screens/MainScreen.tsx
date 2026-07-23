/**
 * MainScreen — pure presentational component for the main view (scanning UI).
 *
 * Receives everything via props; no hooks, no store subscriptions. Renders the
 * same component tree as the original inline JSX in App.tsx.
 */

import { Box, Text } from 'ink';
import { Welcome } from '../components/Welcome';
import { MessageList } from '../components/MessageList';
import { Spinner } from '../components/Spinner';
import { PhaseTimeline } from '../components/PhaseTimeline';
import { PermissionPrompt } from '../components/PermissionPrompt';
import { Select } from '../components/Select';
import { PromptInput } from '../components/PromptInput/index';
import { CommandSuggestions } from '../components/CommandSuggestions';
import { AgentList } from '../components/AgentList';
import { Footer } from '../components/Footer';
import { FullscreenLayout } from '../layout/FullscreenLayout';
import { color, glyph } from '../theme';
import { visibleMessages, type TuiStore, type UiState } from '../store';
import type { CommandSpec } from '../commands';
import type { Overlay } from '../hooks/useCommands';

export interface MainScreenProps {
  state: UiState;
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
  idx: number;
  onInputChange: (value: string) => void;
  onInputSubmit: (value: string) => void;
  onOverlayCancel: () => void;
  completeCommand: (name: string) => void;
}

export function MainScreen({
  state,
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
  idx,
  onInputChange,
  onInputSubmit,
  onOverlayCancel,
  completeCommand,
}: MainScreenProps) {
  const visible = visibleMessages(state);

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
            {showSuggest ? (
              <CommandSuggestions commands={matches} index={idx} />
            ) : null}
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
}
