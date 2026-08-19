#!/usr/bin/env -S tsx
/**
 * Runs ONE real repo through the actual `runHeadless()` pipeline (the same
 * entrypoint `cleak scan --repo <path>` uses) with every LLM call logged —
 * full request (system prompt, messages) and response (text, usage,
 * stopReason) — to a streamed JSONL trace, plus a printed summary. Built to
 * answer a concrete question: why does a real-world case (LAMeD) cost
 * 30-60x more tokens than a synthetic Juliet case — is it many bounded
 * judge calls (call-count multiplication) or something else?
 *
 * Usage:
 *   tsx scripts/debug-case-llm-trace.ts --repo <path> [--out <dir>]
 *     [--mode llm_assisted|no_llm] [--dynamic off|selective|aggressive]
 *     [--tool-select|--no-tool-select] [--provider <name>] [--build "<cmd>"]
 *     [--allocators a,b,c] [--deallocators x,y] (per-project factory
 *     allocators, e.g. a LAMeD case's manifest `allocators`/`deallocators` —
 *     must match the real sweep's config or candidate counts won't line up)
 *     [--consensus-n <n>] (override the config default — a baseline yaml's
 *     own consensusN, e.g. B4's `1`, may differ from ~/.config/cleak/config.json)
 *     [--dry-escalate] (ZERO real LLM calls — logs every bundle that WOULD
 *     escalate to the judge, with the heuristic confidence that triggered
 *     it, to `<out>/escalations.jsonl`, then synthesizes an immediate
 *     non-quota failure so judgeBundleWithLlm swallows to the heuristic
 *     verdict and moves on. For measuring the borderline-band's real
 *     confidence distribution before touching any judge code — see the
 *     "Lever 1" step in the batch-judging plan.)
 *
 * Defaults (--mode llm_assisted --dynamic off --no-tool-select) reproduce
 * baseline B4's exact capability profile — deterministic Stage A, the judge
 * is the only LLM call site — the config that showed the 250K-390K
 * tokens/case anomaly on LAMeD this session.
 */
import { createWriteStream, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runHeadless } from '../apps/leak-inspector-tui/src/surfaces/headless';
import type { CallModel, CallModelRequest, NormalizedResponse } from '@cleak/agent-core';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const repo = flag('repo');
if (!repo) {
  console.error('Usage: tsx scripts/debug-case-llm-trace.ts --repo <path> [--out <dir>] [--mode ...] [--dynamic ...] [--tool-select|--no-tool-select] [--provider <name>] [--build "<cmd>"]');
  process.exit(1);
}
const outDir = flag('out') ?? `results/llm-trace-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
const mode = (flag('mode') as 'no_llm' | 'llm_assisted') ?? 'llm_assisted';
const dynamic = (flag('dynamic') as 'off' | 'selective' | 'aggressive') ?? 'off';
const toolSelect = has('tool-select') ? true : has('no-tool-select') ? false : false; // default off — reproduces B4
const provider = flag('provider');
const build = flag('build');
const extraAllocators = flag('allocators')?.split(',').map((s) => s.trim()).filter(Boolean);
const extraDeallocators = flag('deallocators')?.split(',').map((s) => s.trim()).filter(Boolean);
const consensusNRaw = flag('consensus-n');
const consensusN = consensusNRaw ? Math.max(1, parseInt(consensusNRaw, 10)) : undefined;
const dryEscalate = has('dry-escalate');

mkdirSync(outDir, { recursive: true });
const tracePath = join(outDir, 'llm-trace.jsonl');
const traceStream = createWriteStream(tracePath, { flags: 'a' });
const escalationsPath = join(outDir, 'escalations.jsonl');
const escalationsStream = createWriteStream(escalationsPath, { flags: 'a' });

function onEscalate(info: { bundleId: string; filePath: string; lineNumber: number; functionName?: string; confidence: number; verdict: string }): void {
  escalationsStream.write(JSON.stringify(info) + '\n');
}

type CallKind = 'agentic_turn' | 'single_shot';
let seq = 0;

/** Wraps a CallModel so every request+response is logged, full text, no
 * truncation — the whole point is to see exactly what's being sent. Streamed
 * to disk (not buffered) since a bad case could mean hundreds of calls. */
function withTraceLogging(inner: CallModel): CallModel {
  return async (req: CallModelRequest) => {
    const id = ++seq;
    const t0 = Date.now();
    const callKind: CallKind = req.tools.length > 0 ? 'agentic_turn' : 'single_shot';
    let resp: NormalizedResponse | undefined;
    let error: string | undefined;
    try {
      // Dry-escalate mode: never touch the network. A generic (non-quota)
      // error here is safely swallowed by judgeBundleWithLlm's existing
      // fallback path — the bundle just keeps its heuristic verdict, exactly
      // like a real provider outage would degrade, at zero real cost.
      if (dryEscalate) throw new Error('dry-escalate: no real LLM call made');
      resp = await inner(req);
      return resp;
    } catch (err) {
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw err;
    } finally {
      const line = {
        seq: id,
        ts: new Date().toISOString(),
        durationMs: Date.now() - t0,
        callKind,
        request: {
          systemPrompt: req.systemPrompt,
          messages: req.messages,
          toolNames: req.tools.map((t) => t.name),
        },
        response: resp ? { text: resp.text, toolUses: resp.toolUses, usage: resp.usage, stopReason: resp.stopReason } : undefined,
        error,
      };
      traceStream.write(JSON.stringify(line) + '\n');
    }
  };
}

console.log(`Tracing LLM calls for repo=${repo} mode=${mode} dynamic=${dynamic} toolSelect=${toolSelect}`);
console.log(`  trace  -> ${tracePath}`);
console.log(`  report -> ${outDir}\n`);

const result = await runHeadless({
  repo,
  mode,
  dynamic,
  format: 'json,snapshot',
  toolSelect,
  ...(provider ? { provider } : {}),
  ...(build ? { build } : {}),
  ...(extraAllocators?.length ? { extraAllocators } : {}),
  ...(extraDeallocators?.length ? { extraDeallocators } : {}),
  ...(consensusN != null ? { consensus: { n: consensusN } } : {}),
  wrapCallModel: withTraceLogging,
  onEscalate,
});

await new Promise<void>((resolve) => escalationsStream.end(resolve));

await new Promise<void>((resolve) => traceStream.end(resolve));

console.log(`\n✓ scan complete — ${result.report.summary.totalCandidates} candidates, ` +
  `${result.report.summary.confirmedLeaks} confirmed, ${result.report.summary.likelyLeaks} likely`);
console.log(`  total usage: in=${result.usage.inputTokens} out=${result.usage.outputTokens} mcpCalls=${result.mcpCalls}`);

// ── Summary from the trace itself (independent of the case-level aggregate
// above — this is what actually shows call-count-multiplication vs. per-call
// bloat). Skipped in dry-escalate mode — every call is a synthesized error
// with no usage data, so this table would just be zeros. ──
const lines = readFileSync(tracePath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
if (!dryEscalate) {
  const byKind = new Map<string, { calls: number; inputTokens: number; outputTokens: number; thinkingTokens: number }>();
  for (const l of lines) {
    const agg = byKind.get(l.callKind) ?? { calls: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
    agg.calls++;
    agg.inputTokens += l.response?.usage?.inputTokens ?? 0;
    agg.outputTokens += l.response?.usage?.outputTokens ?? 0;
    agg.thinkingTokens += l.response?.usage?.thinkingTokens ?? 0;
    byKind.set(l.callKind, agg);
  }

  console.log(`\n── Trace summary (${lines.length} total LLM calls) ──`);
  for (const [kind, agg] of byKind) {
    const total = agg.inputTokens + agg.outputTokens;
    console.log(`  ${kind}: ${agg.calls} call(s) · in=${agg.inputTokens} out=${agg.outputTokens} thinking=${agg.thinkingTokens} · total=${total} (${Math.round(total / agg.calls)} tok/call avg)`);
  }

  const topN = [...lines]
    .map((l) => ({ ...l, total: (l.response?.usage?.inputTokens ?? 0) + (l.response?.usage?.outputTokens ?? 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
  console.log(`\n── Top ${topN.length} calls by token total ──`);
  for (const l of topN) {
    const sysChars = l.request.systemPrompt.length;
    const msgChars = JSON.stringify(l.request.messages).length;
    console.log(`  #${l.seq} [${l.callKind}] total=${l.total} (in=${l.response?.usage?.inputTokens ?? 0} out=${l.response?.usage?.outputTokens ?? 0}) · systemPrompt=${sysChars}ch messages=${msgChars}ch · ${l.durationMs}ms`);
  }
}

console.log(`\nFull trace (untruncated request/response text): ${tracePath}`);

if (dryEscalate) {
  const escLines = readFileSync(escalationsPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  console.log(`\n── Escalation confidence distribution (${escLines.length} bundle(s), ZERO real LLM calls made) ──`);
  const buckets = new Map<string, number>();
  for (const e of escLines) {
    const lo = Math.floor(e.confidence * 20) / 20; // 0.05-wide buckets
    const key = `${lo.toFixed(2)}-${(lo + 0.05).toFixed(2)}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  for (const [bucket, count] of [...buckets.entries()].sort()) {
    console.log(`  ${bucket}: ${'#'.repeat(Math.min(count, 60))} (${count})`);
  }
  console.log(`\nFull escalation list: ${escalationsPath}`);
}
