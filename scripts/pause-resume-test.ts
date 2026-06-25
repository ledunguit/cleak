#!/usr/bin/env bun
/** Verifies the loop pauses on model failure and resumes (retries) on user input. */

import { queryLoop, type AgentEvent, type CallModel } from '@cleak/agent-core';

function run(decision: 'resume' | 'abort') {
  let calls = 0;
  const fakeModel: CallModel = async () => {
    calls++;
    if (calls === 1) throw new Error('request timed out after 75s');
    return { text: 'done', toolUses: [], stopReason: 'stop' };
  };
  const events: AgentEvent[] = [];
  const gen = queryLoop({
    systemPrompt: 't',
    messages: [{ role: 'user', content: 'go' }],
    tools: [],
    ctx: {},
    maxTurns: 5,
    deps: { callModel: fakeModel, uuid: () => 'i', now: () => 0, log: () => undefined },
    awaitResume: async () => decision,
  });
  return (async () => {
    let result;
    while (true) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
      events.push(next.value);
    }
    return { events, result, calls };
  })();
}

const fail = (m: string) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};

// resume → retry → finish
{
  const { events, result, calls } = await run('resume');
  if (!events.some((e) => e.type === 'paused')) fail('expected a paused event');
  if (!events.some((e) => e.type === 'resumed')) fail('expected a resumed event');
  if (result.reason !== 'stop') fail(`expected reason 'stop' after resume, got '${result.reason}'`);
  if (calls !== 2) fail(`expected the model to be retried (2 calls), got ${calls}`);
  if (result.turns > 2) fail(`paused turn should not burn budget, turns=${result.turns}`);
  console.log(`✓ resume: paused → user resumed → model retried → finished (turns=${result.turns})`);
}

// abort → stop
{
  const { events, result } = await run('abort');
  if (!events.some((e) => e.type === 'paused')) fail('expected a paused event');
  if (result.reason !== 'aborted') fail(`expected reason 'aborted' after abort, got '${result.reason}'`);
  console.log('✓ abort: paused → user aborted → run stopped');
}

console.log('✓ pause/resume verified');
