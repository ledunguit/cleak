import net from 'net';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve } from 'path';

export interface RuntimePreflightCheck {
  name: string;
  category: 'network' | 'filesystem' | 'toolchain';
  status: 'ok' | 'failed';
  detail: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimePreflightReport {
  ok: boolean;
  checkedAt: string;
  checks: RuntimePreflightCheck[];
}

export interface RuntimePreflightOptions {
  postgresHost?: string;
  postgresPort?: number;
  staticAnalyzerUrl?: string;
  dynamicAnalyzerUrl?: string;
  leakguardRepoRoot?: string;
  /**
   * Probe the local PATH/filesystem for the analysis toolchain
   * (clang/clang++/make/valgrind, leak_guard_tool source, docker).
   *
   * In the distributed deployment the control-plane is only an orchestrator —
   * the build/valgrind toolchain lives in the dynamic-analyzer image and
   * LeakGuard runs inside the `leakguard-tool:dev` container driven by the
   * static-analyzer. So these tools are NOT expected on the control-plane host
   * and probing for them there yields false "failed" checks that wrongly block
   * scans. Only enable this when the analyzers run in-process / co-located with
   * the control-plane (a single-host monolith setup). Defaults to false.
   */
  probeLocalToolchain?: boolean;
}

export async function runRuntimePreflight(
  options: RuntimePreflightOptions = {},
): Promise<RuntimePreflightReport> {
  const postgresHost = options.postgresHost || process.env.POSTGRES_HOST || 'localhost';
  const postgresPort = options.postgresPort || Number(process.env.POSTGRES_PORT || 5432);
  const staticAnalyzer = parseHostPort(options.staticAnalyzerUrl || process.env.STATIC_ANALYZER_URL || 'localhost:50051', 50051);
  const dynamicAnalyzer = parseHostPort(options.dynamicAnalyzerUrl || process.env.DYNAMIC_ANALYZER_URL || 'localhost:50052', 50052);
  const leakguardRoot = resolve(options.leakguardRepoRoot || process.env.LEAKGUARD_REPO_ROOT || 'tools/leak_guard_tool');

  const probeLocalToolchain = options.probeLocalToolchain ?? false;

  const checks: RuntimePreflightCheck[] = [];
  // The control-plane owns persistence and orchestrates the analyzers, so the
  // checks it can meaningfully verify from where it runs are: the database and
  // reachability of the two analyzer services. Their internal toolchain
  // (clang/make/valgrind baked into the dynamic-analyzer image, LeakGuard inside
  // leakguard-tool:dev) is the analyzer's responsibility.
  checks.push(await probeTcpCheck('postgres', postgresHost, postgresPort));
  checks.push(await probeTcpCheck('static-analyzer', staticAnalyzer.host, staticAnalyzer.port));
  checks.push(await probeTcpCheck('dynamic-analyzer', dynamicAnalyzer.host, dynamicAnalyzer.port));

  // Local toolchain probes only apply to a single-host / in-process deployment.
  if (probeLocalToolchain) {
    checks.push(probePathCheck('leakguard-root', leakguardRoot));
    checks.push(probeCommandCheck('clang'));
    checks.push(probeCommandCheck('clang++'));
    checks.push(probeCommandCheck('make'));
    checks.push(probeCommandCheck('valgrind', true));
    checks.push(probeCommandCheck('docker', true));
  }

  return {
    ok: checks.every((check) => check.status === 'ok'),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

async function probeTcpCheck(name: string, host: string, port: number): Promise<RuntimePreflightCheck> {
  const result = await probeTcp(host, port);
  return {
    name,
    category: 'network',
    status: result.ok ? 'ok' : 'failed',
    detail: result.ok ? `reachable at ${host}:${port}` : `unreachable at ${host}:${port}: ${result.error}`,
    metadata: { host, port },
  };
}

function probePathCheck(name: string, path: string): RuntimePreflightCheck {
  return {
    name,
    category: 'filesystem',
    status: existsSync(path) ? 'ok' : 'failed',
    detail: existsSync(path) ? `found at ${path}` : `missing at ${path}`,
    metadata: { path },
  };
}

function probeCommandCheck(command: string, optional = false): RuntimePreflightCheck {
  const result = spawnSync('which', [command], { encoding: 'utf-8' });
  const location = result.status === 0 ? result.stdout.trim() : '';
  const ok = result.status === 0 || optional;

  return {
    name: command,
    category: 'toolchain',
    status: ok ? 'ok' : 'failed',
    detail: result.status === 0
      ? `available at ${location}`
      : optional
        ? 'not installed; optional for some scan modes'
        : 'not installed',
    metadata: location ? { path: location, optional } : { optional },
  };
}

function probeTcp(host: string, port: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolvePromise) => {
    const socket = new net.Socket();
    let settled = false;

    const settle = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(result);
    };

    socket.setTimeout(1500);
    socket.once('connect', () => settle({ ok: true }));
    socket.once('timeout', () => settle({ ok: false, error: 'timeout' }));
    socket.once('error', (error: NodeJS.ErrnoException) => settle({ ok: false, error: error.code || error.message }));
    socket.connect(port, host);
  });
}

function parseHostPort(raw: string, fallbackPort: number): { host: string; port: number } {
  const parts = raw.split(':');
  if (parts.length < 2) {
    return { host: raw, port: fallbackPort };
  }

  const port = Number(parts[parts.length - 1]);
  return {
    host: parts.slice(0, -1).join(':'),
    port: Number.isFinite(port) ? port : fallbackPort,
  };
}
