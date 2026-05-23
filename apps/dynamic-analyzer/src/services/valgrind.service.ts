import { Injectable } from '@nestjs/common';
import { execSync } from 'child_process';
import { RunManagerService } from './run-manager.service';
import { ResultParserService } from './result-parser.service';

@Injectable()
export class ValgrindService {
  constructor(
    private readonly runManager: RunManagerService,
    private readonly resultParser: ResultParserService,
  ) {}

  async runMemcheck(
    binaryPath: string,
    args: string[],
    runId?: string,
    timeoutSec?: number,
  ) {
    const id = runId || `vg_${Date.now()}`;
    const timeout = timeoutSec || 120;

    try {
      const cmd = `valgrind --tool=memcheck --leak-check=full --xml=yes --xml-file=/tmp/${id}.xml ${binaryPath} ${(args || []).join(' ')}`;
      console.error(`[Valgrind] Running: ${cmd}`);
      const output = execSync(cmd, {
        timeout: timeout * 1000,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });

      const rawFindings = this.resultParser.parseValgrindXml(`/tmp/${id}.xml`);
      // Map findings to flat LeakFinding proto format
      const findings = rawFindings.map((f, i) => this.toLeakFinding(f, id, i));

      this.runManager.saveRun(id, {
        tool: 'valgrind',
        binaryPath,
        output,
        findings,
        success: true,
      });

      const stats = {
        findingCount: findings.length,
        high: findings.filter(f => f.severity === 'high').length,
        medium: findings.filter(f => f.severity === 'medium').length,
        low: findings.filter(f => f.severity === 'low').length,
      };

      return {
        success: true,
        runId: id,
        findings,
        summary: stats,
      };
    } catch (err: any) {
      console.error(`[Valgrind] Error: ${err.message}`);
      return {
        success: false,
        runId: id,
        findings: [],
        summary: err.message,
      };
    }
  }

  private toLeakFinding(f: any, runId: string, index: number) {
    const leakBytes = Number(f.aux?.leak?.bytes ?? f.aux?.size ?? 0);
    const leakBlocks = f.aux?.leak?.blocks || 0;
    const severity = this.mapSeverity(f.kind, f.message);

    // Find the first stack frame with real source file info (skip allocator internals)
    const userFrame = (f.stack || []).find((s: any) =>
      s.file && !s.file.includes('/usr/') && !s.file.includes('/libc') && !s.file.includes('/libgcc')
    ) || f.stack?.[0] || {};

    return {
      id: `mc-${String(index + 1).padStart(4, '0')}`,
      tool: 'memcheck',
      runId: runId,
      functionName: userFrame.function || '',
      filePath: userFrame.file || '',
      lineNumber: userFrame.line || 0,
      bytesLost: leakBytes,
      blocksLost: Number(f.aux?.leak?.blocks ?? 0),
      severity,
      stackTrace: (f.stack || []).map((s: any) => `${s.function} at ${s.file}:${s.line}`).join('\n'),
      allocationType: f.aux?.leak?.kind || '',
      status: 'open',
    };
  }

  private mapSeverity(kind: string, message: string): string {
    const k = (kind || '').toLowerCase();
    const m = (message || '').toLowerCase();
    if (k.includes('invalidread') || m.includes('invalid read')) return 'high';
    if (k.includes('invalidwrite') || m.includes('invalid write')) return 'high';
    if (k.includes('useafterfree') || m.includes('use after free')) return 'high';
    if (k.includes('definitelylost') || m.includes('definitely lost')) return 'medium';
    if (k.includes('possiblylost') || m.includes('possibly lost')) return 'low';
    return 'medium';
  }

  async getReport(runId: string) {
    return this.runManager.getRun(runId);
  }

  async listFindings(
    runId: string,
    severity?: string,
    _functionName?: string,
  ) {
    const run = await this.runManager.getRun(runId);
    let findings = run?.findings || [];

    if (severity) {
      findings = findings.filter((f: any) => f.severity === severity);
    }

    return { findings };
  }
}
