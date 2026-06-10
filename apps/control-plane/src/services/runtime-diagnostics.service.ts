import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { runRuntimePreflight } from '../utils/runtime-preflight';

@Injectable()
export class RuntimeDiagnosticsService {
  constructor(private readonly config: ConfigService) {}

  async getPreflightReport() {
    // In MCP mode the analyzers listen on HTTP (Streamable MCP) ports, not gRPC,
    // so probe those instead — otherwise the gRPC ports look "unreachable".
    const mode = (process.env.TRANSPORT_MODE || this.config.get<string>('TRANSPORT_MODE', 'grpc')).toLowerCase();
    const staticAnalyzerUrl = mode === 'mcp'
      ? this.mcpHostPort(this.config.get<string>('STATIC_ANALYZER_MCP_URL', 'http://localhost:50061/mcp'))
      : this.config.get<string>('STATIC_ANALYZER_URL', 'localhost:50051');
    const dynamicAnalyzerUrl = mode === 'mcp'
      ? this.mcpHostPort(this.config.get<string>('DYNAMIC_ANALYZER_MCP_URL', 'http://localhost:50062/mcp'))
      : this.config.get<string>('DYNAMIC_ANALYZER_URL', 'localhost:50052');

    // Only probe the local toolchain (clang/make/valgrind/scan-build) when the
    // analyzers run in-process/co-located. In the distributed Docker deployment
    // these live in the analyzer images, not on the control-plane.
    const probeLocalToolchain =
      (process.env.RUNTIME_PREFLIGHT_LOCAL_TOOLCHAIN ||
        this.config.get<string>('RUNTIME_PREFLIGHT_LOCAL_TOOLCHAIN', 'false')).toLowerCase() === 'true';

    return runRuntimePreflight({
      postgresHost: this.config.get<string>('POSTGRES_HOST', 'localhost'),
      postgresPort: this.config.get<number>('POSTGRES_PORT', 5432),
      staticAnalyzerUrl,
      dynamicAnalyzerUrl,
      probeLocalToolchain,
    });
  }

  /** Extract host:port from an MCP HTTP URL for a TCP reachability probe. */
  private mcpHostPort(url: string): string {
    try {
      const u = new URL(url);
      return `${u.hostname}:${u.port || '80'}`;
    } catch {
      return url;
    }
  }

  async getBlockingIssues() {
    const report = await this.getPreflightReport();
    const blockingChecks = report.checks.filter(
      (check) => check.status === 'failed' && !(check.metadata as any)?.optional,
    );

    return {
      report,
      blockingChecks,
      ok: blockingChecks.length === 0,
    };
  }

  isPreflightEnforced(): boolean {
    return this.config.get<string>('SCAN_PREFLIGHT_ENFORCED', 'true') !== 'false';
  }
}
