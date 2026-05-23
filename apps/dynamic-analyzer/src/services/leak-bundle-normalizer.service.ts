import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';

interface StackFrame {
  function: string | null;
  file: string | null;
  line: number | null;
}

interface Finding {
  kind: string;
  message: string;
  stack: StackFrame[];
  originStack: StackFrame[];
  aux: Record<string, any>;
}

interface NormalizedFinding {
  findingId: string;
  tool: string;
  kind: string;
  severity: string;
  confidence: string;
  message: string;
  location: { file: string | null; line: number | null; function: string | null };
  stack: StackFrame[];
  aux: Record<string, any>;
  origin: { stack: StackFrame[] };
  signature: string;
}

interface NormalizedReport {
  runId: string;
  tool: string;
  findings: NormalizedFinding[];
  stats: { findingCount: number; high: number; medium: number; low: number };
  generatedAt: string;
}

@Injectable()
export class LeakBundleNormalizerService {
  normalizeMemcheck(
    runId: string,
    rawErrors: Finding[],
    xmlPath?: string,
    logPath?: string,
  ): NormalizedReport {
    const findings: NormalizedFinding[] = [];
    let high = 0, medium = 0, low = 0;

    for (let i = 0; i < rawErrors.length; i++) {
      const raw = rawErrors[i];
      const topFrame = raw.stack[0] || { function: null, file: null, line: null };

      const [severity, confidence] = this.mapMemcheckSeverity(raw.kind, raw.message);
      if (severity === 'high') high++;
      else if (severity === 'medium') medium++;
      else low++;

      const signature = this.computeSignature(raw.kind, raw.message, topFrame);

      findings.push({
        findingId: `mc-${String(i + 1).padStart(4, '0')}`,
        tool: 'memcheck',
        kind: raw.kind,
        severity,
        confidence,
        message: raw.message || raw.kind,
        location: {
          file: topFrame.file,
          line: topFrame.line,
          function: topFrame.function,
        },
        stack: raw.stack,
        aux: raw.aux,
        origin: { stack: raw.originStack },
        signature,
      });
    }

    return {
      runId,
      tool: 'memcheck',
      findings,
      stats: { findingCount: findings.length, high, medium, low },
      generatedAt: new Date().toISOString(),
    };
  }

  normalizeAsan(
    runId: string,
    rawErrors: Finding[],
    logPath?: string,
  ): NormalizedReport {
    const findings: NormalizedFinding[] = [];
    let high = 0, medium = 0, low = 0;

    for (let i = 0; i < rawErrors.length; i++) {
      const raw = rawErrors[i];
      const topFrame = raw.stack[0] || { function: null, file: null, line: null };

      const [severity, confidence] = this.mapAsanSeverity(raw.kind, raw.message);
      if (severity === 'high') high++;
      else if (severity === 'medium') medium++;
      else low++;

      const signature = this.computeSignature(raw.kind, raw.message, topFrame);

      findings.push({
        findingId: `asan-${String(i + 1).padStart(4, '0')}`,
        tool: 'asan',
        kind: raw.kind,
        severity,
        confidence,
        message: raw.message || raw.kind,
        location: {
          file: topFrame.file,
          line: topFrame.line,
          function: topFrame.function,
        },
        stack: raw.stack,
        aux: {},
        origin: { stack: [] },
        signature,
      });
    }

    return {
      runId,
      tool: 'asan',
      findings,
      stats: { findingCount: findings.length, high, medium, low },
      generatedAt: new Date().toISOString(),
    };
  }

  private mapMemcheckSeverity(kind: string, message: string): [string, string] {
    const k = kind.toLowerCase();
    const msg = message.toLowerCase();

    if (k.includes('invalidread') || msg.includes('invalid read')) return ['high', 'high'];
    if (k.includes('invalidwrite') || msg.includes('invalid write')) return ['high', 'high'];
    if (k.includes('useafterfree') || msg.includes('use after free')) return ['high', 'high'];
    if (msg.includes('conditional') && msg.includes('uninitialised')) return ['medium', 'medium'];
    if (k.includes('definitelylost') || msg.includes('definitely lost')) return ['medium', 'medium'];
    if (k.includes('possiblylost') || msg.includes('possibly lost')) return ['low', 'medium'];

    return ['medium', 'low'];
  }

  private mapAsanSeverity(kind: string, _message: string): [string, string] {
    const k = kind.toLowerCase();

    if (k.includes('use-after-free')) return ['high', 'high'];
    if (k.includes('buffer-overflow')) return ['high', 'high'];
    if (k.includes('use-after-scope')) return ['high', 'high'];
    if (k.includes('leak')) return ['medium', 'medium'];

    return ['medium', 'low'];
  }

  private computeSignature(
    kind: string,
    message: string,
    topFrame: StackFrame,
  ): string {
    const parts = [
      kind || '',
      message || '',
      topFrame.function || '',
      topFrame.file || '',
      String(topFrame.line || ''),
    ];
    const raw = parts.join('|');
    return createHash('sha1').update(raw, 'utf-8').digest('hex');
  }
}
