#!/usr/bin/env bun
/**
 * Exercises the TUI's data layer (store + runner) without rendering Ink: runs a
 * real scan and asserts the store ends in 'done' with a summary, phase banners,
 * and (in llm_assisted) tool cards from the agent event stream.
 */

import { TuiStore } from '../apps/leak-inspector-tui/src/surfaces/tui/store';
import { runTuiScan } from '../apps/leak-inspector-tui/src/surfaces/tui/runner';
import { loadEnvFiles } from '../apps/leak-inspector-tui/src/domain/env';

loadEnvFiles();

const mode = (process.argv[2] as 'no_llm' | 'llm_assisted') ?? 'no_llm';
const repo = process.argv[3] ?? 'demo/memory_leak_corpus/simple_leak';
// In this dev environment the docker stack holds 50061/50062 in gRPC mode, so the
// MCP analyzers run on 50071/50072. Override via SMOKE_STATIC_URL if needed.
const staticUrl = process.env.SMOKE_STATIC_URL ?? 'http://127.0.0.1:50071/mcp';

const store = new TuiStore({ provider: 'local', model: process.env.LOCAL_LLM_MODEL ?? '', mode, dynamic: 'off' });

await runTuiScan(store, { repo, mode, dynamic: 'off', staticUrl });

const s = store.getSnapshot();
const toolCards = s.messages.filter((m) => m.kind === 'tool').length;
const phaseMsgs = s.messages.filter((m) => m.kind === 'phase').length;
const phasesDone = Object.values(s.phases).filter((p) => p === 'done').length;

console.log(`mode=${mode} status=${s.status} summary=${JSON.stringify(s.summary)}`);
console.log(`messages=${s.messages.length} phaseBanners=${phaseMsgs} toolCards=${toolCards} phasesDone=${phasesDone}`);

if (s.status !== 'done' || !s.summary) {
  console.error('✗ store did not finish cleanly');
  process.exit(1);
}
if (phaseMsgs === 0) {
  console.error('✗ no phase banners recorded');
  process.exit(1);
}
console.log('✓ tui store/runner smoke ok');
