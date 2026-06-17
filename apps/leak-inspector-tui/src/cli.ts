#!/usr/bin/env bun
/**
 * leak-tui — an agentic terminal investigator for C/C++ memory leaks.
 *
 * Commands:
 *   tools                 discover and list the analyzer MCP tools (connectivity check)
 *   scan   --repo <path>  run a headless investigation, write reports to results/<id>
 *   tui                   interactive terminal UI
 *   eval   --corpus <p>   batch-evaluate a labeled corpus
 */

import { Command } from 'commander';
import { McpClient, loadMcpTools } from '@mcpvul/agent-core';
import { loadConfig, type Provider } from './config';
import { mcpToolFlags, phaseForMcpTool } from './domain/mcpToolPlan';

const program = new Command();

program
  .name('leak-tui')
  .description('Agentic terminal investigator for C/C++ memory leaks')
  .version('0.1.0');

program
  .command('tools')
  .description('Connect to the static + dynamic analyzer MCP servers and list their tools')
  .option('--static-url <url>', 'static analyzer MCP url')
  .option('--dynamic-url <url>', 'dynamic analyzer MCP url')
  .action(async (opts) => {
    const cfg = loadConfig({
      ...(opts.staticUrl ? { staticUrl: opts.staticUrl } : {}),
      ...(opts.dynamicUrl ? { dynamicUrl: opts.dynamicUrl } : {}),
    });
    let failures = 0;
    for (const [label, url] of [
      ['static', cfg.staticUrl],
      ['dynamic', cfg.dynamicUrl],
    ] as const) {
      const client = new McpClient(url, label);
      process.stdout.write(`\n${label} analyzer  ${url}\n`);
      try {
        const tools = await loadMcpTools(client, mcpToolFlags);
        process.stdout.write(`  ${tools.length} tools:\n`);
        for (const t of tools) {
          const flags = `${t.isReadOnly({}) ? 'ro' : 'rw'}${t.isConcurrencySafe({}) ? ',par' : ',seq'}`;
          const phase = phaseForMcpTool(t.name) ?? '-';
          process.stdout.write(`    • ${t.name.padEnd(22)} [${flags}] ${phase.padEnd(13)} ${t.description}\n`);
        }
      } catch (err: any) {
        failures++;
        process.stdout.write(`  ✗ connection failed: ${err?.message ?? err}\n`);
      } finally {
        await client.close();
      }
    }
    if (failures) {
      process.stdout.write(
        `\nHint: start the analyzers with TRANSPORT_MODE=mcp, e.g.\n` +
          `  (cd apps/static-analyzer  && TRANSPORT_MODE=mcp MCP_HTTP_PORT=50061 bun run dev)\n` +
          `  (cd apps/dynamic-analyzer && TRANSPORT_MODE=mcp MCP_HTTP_PORT=50062 bun run dev)\n`,
      );
      process.exitCode = 1;
    }
  });

program
  .command('scan')
  .description('Headless investigation of a repository (writes reports to results/<scanId>)')
  .requiredOption('--repo <path>', 'path to the C/C++ repository to scan')
  .option('--mode <mode>', 'no_llm | llm_assisted', 'llm_assisted')
  .option('--dynamic <mode>', 'off | selective | aggressive', 'off')
  .option('--provider <provider>', 'local | openai | anthropic')
  .option('--format <list>', 'comma list: json,markdown,html,snapshot,csv', 'json,markdown,snapshot')
  .option('--build <cmd>', 'build command for dynamic analysis')
  .option('--file-limit <n>', 'cap on indexed files', (v) => parseInt(v, 10))
  .option('--static-url <url>', 'static analyzer MCP url')
  .option('--dynamic-url <url>', 'dynamic analyzer MCP url')
  .option('--host-root <path>', 'host repo root (for path mapping when analyzers run in Docker)')
  .option('--analyzer-root <path>', 'analyzer-visible root, e.g. /workspace (Docker mount)')
  .action(async (opts) => {
    if (opts.hostRoot) process.env.HOST_ROOT = opts.hostRoot;
    if (opts.analyzerRoot) process.env.ANALYZER_ROOT = opts.analyzerRoot;
    const { runHeadless } = await import('./surfaces/headless');
    try {
      await runHeadless({
        repo: opts.repo,
        mode: opts.mode,
        dynamic: opts.dynamic,
        provider: opts.provider,
        format: opts.format,
        build: opts.build,
        fileLimit: opts.fileLimit,
        staticUrl: opts.staticUrl,
        dynamicUrl: opts.dynamicUrl,
      });
    } catch (err: any) {
      process.stderr.write(`scan failed: ${err?.message ?? err}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('tui', { isDefault: true })
  .description('Interactive terminal UI')
  .option('--provider <provider>', 'local | openai | anthropic')
  // No defaults here: a hardcoded default makes commander set opts.mode/opts.dynamic
  // even when the user omits the flag, which would clobber the saved /config
  // preference (launchTui does `opts.dynamic ?? prefs.defaultDynamic`). Leaving
  // them undefined preserves precedence: CLI flag > saved preference > default.
  .option('--mode <mode>', 'no_llm | llm_assisted (default: saved preference)')
  .option('--dynamic <mode>', 'off | selective | aggressive (default: saved preference)')
  .option('--static-url <url>', 'static analyzer MCP url')
  .option('--dynamic-url <url>', 'dynamic analyzer MCP url')
  .option('--host-root <path>', 'host repo root (for path mapping when analyzers run in Docker)')
  .option('--analyzer-root <path>', 'analyzer-visible root, e.g. /workspace (Docker mount)')
  .action(async (opts) => {
    if (opts.hostRoot) process.env.HOST_ROOT = opts.hostRoot;
    if (opts.analyzerRoot) process.env.ANALYZER_ROOT = opts.analyzerRoot;
    const { launchTui } = await import('./surfaces/tui/index');
    await launchTui({
      provider: opts.provider,
      mode: opts.mode,
      dynamic: opts.dynamic,
      staticUrl: opts.staticUrl,
      dynamicUrl: opts.dynamicUrl,
    });
  });

program
  .command('eval')
  .description('Benchmark a labeled corpus → Precision/Recall/F1 + thesis artifacts')
  .requiredOption('--corpus <path>', 'corpus directory (with a v2 corpus_manifest.json)')
  .option('--mode <mode>', 'no_llm | llm_assisted', 'llm_assisted')
  .option('--dynamic <mode>', 'off | selective | aggressive', 'off')
  .option('--limit <n>', 'evaluate only the first N cases (dev runs)', (v) => parseInt(v, 10))
  .option('--concurrency <n>', 'parallel scans', (v) => parseInt(v, 10))
  .option('--resume', 'reuse cached per-case results in the out dir', false)
  .option('--allow-heuristic-fallback', 'permit llm_assisted to fall back to the heuristic judge when no LLM key is set (results will NOT reflect the LLM)', false)
  .option('--consensus-n <n>', 'multi-agent consensus: number of independent LLM samples (1 = single-LLM baseline)', (v) => parseInt(v, 10))
  .option('--consensus-rule <rule>', 'consensus rule: majority | weighted | unanimous-to-flag')
  .option('--out <dir>', 'output dir (default results/eval-<corpus>-<mode>-<ts>)')
  .option('--static-url <url>', 'static analyzer MCP url')
  .option('--dynamic-url <url>', 'dynamic analyzer MCP url')
  .action(async (opts) => {
    const { loadEnvFiles } = await import('./domain/env');
    const { runEval } = await import('./domain/evalHarness');
    const { writeEval } = await import('./domain/evalReport');
    const { basename } = await import('node:path');
    loadEnvFiles();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir =
      opts.out ?? `${process.env.RESULTS_DIR ?? 'results'}/eval-${basename(opts.corpus)}-${opts.mode}-${stamp}`;
    process.stdout.write(`Evaluating ${opts.corpus} (mode=${opts.mode}, dynamic=${opts.dynamic}) → ${outDir}\n`);
    const result = await runEval({
      corpusDir: opts.corpus,
      mode: opts.mode,
      dynamic: opts.dynamic,
      outDir,
      limit: opts.limit,
      concurrency: opts.concurrency,
      resume: opts.resume,
      allowHeuristicFallback: opts.allowHeuristicFallback,
      consensusN: opts.consensusN,
      consensusRule: opts.consensusRule,
      staticUrl: opts.staticUrl,
      dynamicUrl: opts.dynamicUrl,
      onProgress: (done, total, id) => process.stdout.write(`  [${done}/${total}] ${id}\n`),
    });
    const files = writeEval(outDir, result);
    const m = result.overall;
    process.stdout.write(
      `\n── ${opts.mode} ── P=${m.precision.toFixed(3)} R=${m.recall.toFixed(3)} F1=${m.f1.toFixed(3)} ` +
        `Acc=${m.accuracy.toFixed(3)} (TP=${m.tp} FP=${m.fp} FN=${m.fn} TN=${m.tn})\n`,
    );
    process.stdout.write(`✓ wrote ${files.length} artifacts to ${outDir}\n`);
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});

export { program };
