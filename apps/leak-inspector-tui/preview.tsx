#!/usr/bin/env bun
/**
 * Renders the TUI to text (ink-testing-library, no TTY) so the layout/design can
 * be inspected: the fresh welcome screen and an active scan. Run from repo root:
 *   bun apps/leak-inspector-tui/preview.tsx
 */

import { render } from 'ink-testing-library';
import { App } from './src/surfaces/tui/App';
import { TuiStore } from './src/surfaces/tui/store';
import { ScanEventName } from './src/orchestrator/events';
import { Select } from './src/surfaces/tui/components/Select';
import { CommandSuggestions } from './src/surfaces/tui/components/CommandSuggestions';
import { matchCommands } from './src/surfaces/tui/commands';
import { color } from './src/surfaces/tui/theme';

const recent = ['scan_simple_leak_20260610-1158', 'scan_early_return_leak_20260610-1236'];
const cwd = '/Users/zed/Master/leak-investigator';

{
  const store = new TuiStore({ provider: 'local', model: 'mimo/mimo-v2.5-pro', mode: 'llm_assisted', dynamic: 'off' });
  const { lastFrame, unmount } = render(
    <App store={store} staticUrl="http://127.0.0.1:50071/mcp" cwd={cwd} resultsDir="results" recentScans={recent} />,
  );
  console.log('\n══════════════ FRESH ══════════════\n');
  console.log(lastFrame());
  unmount();
}

{
  const store = new TuiStore({ provider: 'local', model: 'mimo/mimo-v2.5-pro', mode: 'llm_assisted', dynamic: 'off' });
  store.addUserMessage('/scan demo/memory_leak_corpus/early_return_leak');
  store.beginRun('scan_demo_x', 'llm_assisted');
  store.applyScanEvent({ seq: 0, ts: 0, name: ScanEventName.DISCOVERY_STARTED });
  store.applyScanEvent({ seq: 1, ts: 0, name: ScanEventName.DISCOVERY_FINISHED });
  store.applyScanEvent({ seq: 2, ts: 0, name: ScanEventName.INVESTIGATION_STARTED });
  store.applyAgentEvent({ type: 'thinking', text: 'make_buffer returns the allocation to main, which never frees it — this looks like an interprocedural leak. Let me confirm with functionSummary and pathConstraints.' });
  store.applyAgentEvent({ type: 'assistant_text', text: 'Investigating 3 candidates; gathering static evidence.' });
  store.applyAgentEvent({ type: 'tool_use', id: 'a', name: 'functionSummary', input: { functionName: 'process' }, isReadOnly: true });
  store.applyAgentEvent({ type: 'tool_result', id: 'a', name: 'functionSummary', output: { allocFreeBalance: -1 }, isError: false, durationMs: 14 });
  store.applyAgentEvent({ type: 'tool_use', id: 'b', name: 'pathConstraints', input: { filePath: 'early_return_leak/main.c', lineNumber: 26 }, isReadOnly: true });
  store.applyAgentEvent({ type: 'tool_result', id: 'b', name: 'pathConstraints', output: { feasiblePaths: 2 }, isError: false, durationMs: 11 });
  store.applyAgentEvent({ type: 'tool_use', id: 'c', name: 'record_verdict', input: { bundleId: 'bundle_a1b2c3', verdict: 'confirmed_leak' }, isReadOnly: false });
  const { lastFrame, unmount } = render(
    <App store={store} staticUrl="http://127.0.0.1:50071/mcp" cwd={cwd} resultsDir="results" recentScans={recent} />,
  );
  console.log('\n══════════════ ACTIVE SCAN ══════════════\n');
  console.log(lastFrame());
  unmount();
}

{
  const store = new TuiStore({ provider: 'local', model: 'mimo/mimo-v2.5-pro', mode: 'llm_assisted', dynamic: 'off' });
  store.addUserMessage('/scan demo/memory_leak_corpus/array_leak');
  store.beginRun('scan_demo_x', 'llm_assisted');
  store.applyScanEvent({ seq: 0, ts: 0, name: ScanEventName.INVESTIGATION_STARTED });
  store.applyAgentEvent({ type: 'tool_use', id: 'a', name: 'functionSummary', input: { functionName: 'cleanup_partial' }, isReadOnly: true });
  store.applyAgentEvent({ type: 'tool_result', id: 'a', name: 'functionSummary', output: { leaky: true }, isError: false, durationMs: 37 });
  store.applyAgentEvent({ type: 'notice', text: 'LLM timed out after 75s; retry 1/2 in 1s' });
  store.applyAgentEvent({ type: 'notice', text: 'LLM timed out after 75s; retry 2/2 in 2s' });
  store.applyAgentEvent({ type: 'paused', reason: 'request timed out after 75s' });
  const { lastFrame, unmount } = render(
    <App store={store} staticUrl="http://127.0.0.1:50071/mcp" cwd={cwd} resultsDir="results" recentScans={recent} />,
  );
  console.log('\n══════════════ PAUSED ══════════════\n');
  console.log(lastFrame());
  unmount();
}

{
  const { lastFrame, unmount } = render(<CommandSuggestions commands={matchCommands('/')} index={1} />);
  console.log('\n══════════════ COMMAND SUGGESTIONS (type /) ══════════════\n');
  console.log(lastFrame());
  unmount();
}

{
  const { lastFrame, unmount } = render(
    <Select
      title="/dynamic · choose"
      options={[
        { label: 'off', value: 'off', description: 'static analysis only' },
        { label: 'selective', value: 'selective', description: 'agent runs sanitizers/valgrind when useful', color: color.accent },
        { label: 'aggressive', value: 'aggressive', description: 'always attempt a dynamic run' },
      ]}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
  );
  console.log('\n══════════════ SELECT OVERLAY (/dynamic) ══════════════\n');
  console.log(lastFrame());
  unmount();
}

{
  const { lastFrame, unmount } = render(
    <Select
      title="findings in scan_array_leak_xx — pick one"
      options={[
        { label: '🔴 make_buffer@17  confirmed_leak (98%)', value: '0', color: color.error, description: 'main.c' },
        { label: '🟢 duplicate@6  false_positive (95%)', value: '1', color: color.success, description: 'main.c' },
      ]}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
  );
  console.log('\n══════════════ REPORT FINDING PICKER ══════════════\n');
  console.log(lastFrame());
  unmount();
}

process.exit(0);
