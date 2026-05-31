import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { from, Observable } from 'rxjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DynamicAnalyzerService, StaticAnalyzerService } from './scan-orchestrator.service';

/**
 * Talks to the static/dynamic analyzers over REAL MCP (Streamable HTTP) and
 * exposes adapters that satisfy the same StaticAnalyzerService /
 * DynamicAnalyzerService interfaces the gRPC clients provide. Each method
 * returns an Observable (via rxjs `from`) so the orchestrator's
 * `firstValueFrom(svc.method(args))` calls work unchanged across both transports.
 *
 * Used only when TRANSPORT_MODE=mcp; otherwise the gRPC clients are used and
 * this manager never connects.
 */
@Injectable()
export class McpClientManager implements OnModuleInit {
  private readonly logger = new Logger(McpClientManager.name);
  private staticClient?: Client;
  private dynamicClient?: Client;
  private connectPromise?: Promise<void>;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    if (this.transportMode() === 'mcp') {
      try {
        await this.ensureConnected();
      } catch (err: any) {
        this.logger.warn(`MCP eager connect failed (will retry lazily on first call): ${err.message}`);
      }
    }
  }

  private transportMode(): string {
    return (process.env.TRANSPORT_MODE || this.config.get<string>('TRANSPORT_MODE') || 'grpc').toLowerCase();
  }

  private async ensureConnected(): Promise<void> {
    if (this.staticClient && this.dynamicClient) return;
    if (!this.connectPromise) this.connectPromise = this.connect();
    await this.connectPromise;
  }

  private async connect(): Promise<void> {
    const staticUrl =
      process.env.STATIC_ANALYZER_MCP_URL || this.config.get<string>('STATIC_ANALYZER_MCP_URL') || 'http://localhost:50061/mcp';
    const dynamicUrl =
      process.env.DYNAMIC_ANALYZER_MCP_URL || this.config.get<string>('DYNAMIC_ANALYZER_MCP_URL') || 'http://localhost:50062/mcp';

    this.staticClient = new Client({ name: 'control-plane-static', version: '1.0.0' });
    await this.staticClient.connect(new StreamableHTTPClientTransport(new URL(staticUrl)));

    this.dynamicClient = new Client({ name: 'control-plane-dynamic', version: '1.0.0' });
    await this.dynamicClient.connect(new StreamableHTTPClientTransport(new URL(dynamicUrl)));

    this.logger.log(`MCP clients connected (static=${staticUrl}, dynamic=${dynamicUrl})`);
  }

  private async callTool(which: 'static' | 'dynamic', name: string, args: Record<string, any>): Promise<any> {
    await this.ensureConnected();
    const client = which === 'static' ? this.staticClient! : this.dynamicClient!;
    const res: any = await client.callTool({ name, arguments: args ?? {} });
    if (res?.isError) {
      const msg = Array.isArray(res.content) ? res.content.map((c: any) => c.text).join('; ') : 'unknown error';
      throw new Error(`MCP tool ${name} failed: ${msg}`);
    }
    // Prefer structuredContent (full JSON object); fall back to parsing text content.
    if (res?.structuredContent !== undefined && res.structuredContent !== null) return res.structuredContent;
    const text = Array.isArray(res?.content) ? res.content.find((c: any) => c.type === 'text')?.text : undefined;
    return text ? JSON.parse(text) : {};
  }

  private invoke(which: 'static' | 'dynamic', name: string, args: Record<string, any>): Observable<any> {
    return from(this.callTool(which, name, args));
  }

  getStaticAdapter(): StaticAnalyzerService {
    const call = (name: string, data: any) => this.invoke('static', name, data);
    return {
      indexFiles: (d) => call('indexFiles', d),
      candidateScan: (d) => call('candidateScan', d),
      astScan: (d) => call('astScan', d),
      callGraph: (d) => call('callGraph', d),
      functionSummary: (d) => call('functionSummary', d),
      interproceduralFlow: (d) => call('interproceduralFlow', d),
      pathConstraints: (d) => call('pathConstraints', d),
      ownershipSummary: (d) => call('ownershipSummary', d),
      ownershipConventions: (d) => call('ownershipConventions', d),
      leakguardRun: (d) => call('leakguardRun', d),
      leakguardGetReport: (d) => call('leakguardGetReport', d),
    };
  }

  getDynamicAdapter(): DynamicAnalyzerService {
    const call = (name: string, data: any) => this.invoke('dynamic', name, data);
    return {
      buildTarget: (d) => call('buildTarget', d),
      valgrindMemcheck: (d) => call('valgrindMemcheck', d),
      asanRun: (d) => call('asanRun', d),
      lsanRun: (d) => call('lsanRun', d),
    };
  }
}
