import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';

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

interface LeakBlock {
  bytes: number | null;
  blocks: number | null;
  kind: string | null;
}

@Injectable()
export class ResultParserService {
  // ── Valgrind XML Parser ──

  parseValgrindXml(xmlPath: string): Finding[] {
    try {
      const xml = readFileSync(xmlPath, 'utf-8');
      return this.parseValgrindXmlString(xml);
    } catch {
      return [];
    }
  }

  parseValgrindXmlString(xml: string): Finding[] {
    const findings: Finding[] = [];

    // Simple XML parser for Valgrind output using regex
    const errorRegex = /<error>([\s\S]*?)<\/error>/g;
    let match: RegExpExecArray | null;

    while ((match = errorRegex.exec(xml)) !== null) {
      const errorXml = match[1];
      const finding = this.parseValgrindError(errorXml);
      if (finding) findings.push(finding);
    }

    return findings;
  }

  private parseValgrindError(xml: string): Finding | null {
    const kind = this.extractXmlText(xml, 'kind') || 'Unknown';
    const message = this.extractXmlText(xml, 'xwhat/text')
      || this.extractXmlText(xml, 'what')
      || kind;

    const stack = this.parseValgrindStack(xml, 'stack');
    const originStack = this.parseValgrindStack(xml, 'origin/stack');

    const aux: Record<string, any> = {};
    aux.address = this.extractXmlText(xml, 'addr');
    aux.size = this.safeInt(this.extractXmlText(xml, 'size'));

    // Parse leak info from <xwhat><leak> or <xwhat><leakedbytes>/<leakedblocks>
    const leakMatch = /<leak>([\s\S]*?)<\/leak>/.exec(xml);
    if (leakMatch) {
      const leakXml = leakMatch[1];
      aux.leak = {
        bytes: this.safeInt(this.extractXmlText(leakXml, 'bytes')),
        blocks: this.safeInt(this.extractXmlText(leakXml, 'blocks')),
        kind: this.extractXmlText(leakXml, 'kind'),
      } as LeakBlock;
    } else {
      // Flat <leakedbytes> / <leakedblocks> in <xwhat>
      const leakedBytes = this.safeInt(this.extractXmlText(xml, 'xwhat/leakedbytes'));
      const leakedBlocks = this.safeInt(this.extractXmlText(xml, 'xwhat/leakedblocks'));
      if (leakedBytes != null || leakedBlocks != null) {
        aux.leak = {
          bytes: leakedBytes,
          blocks: leakedBlocks,
          kind: kind,
        } as LeakBlock;
      }
    }

    aux.auxwhat = this.extractXmlText(xml, 'auxwhat');

    return { kind, message, stack, originStack, aux };
  }

  private parseValgrindStack(xml: string, path: string): StackFrame[] {
    // Navigate nested path: "stack" or "origin/stack"
    const parts = path.split('/');
    let currentXml = xml;

    for (const part of parts) {
      const regex = new RegExp(`<${part}>([\\s\\S]*?)<\\/${part}>`);
      const m = regex.exec(currentXml);
      if (!m) return [];
      currentXml = m[1];
    }

    const frames: StackFrame[] = [];
    const frameRegex = /<frame>([\s\S]*?)<\/frame>/g;
    let fm: RegExpExecArray | null;

    while ((fm = frameRegex.exec(currentXml)) !== null) {
      const frameXml = fm[1];
      frames.push({
        function: this.extractXmlText(frameXml, 'fn'),
        file: this.extractXmlText(frameXml, 'file'),
        line: this.safeInt(this.extractXmlText(frameXml, 'line')),
      });
    }

    return frames;
  }

  private extractXmlText(xml: string, tag: string): string | null {
    // Support nested path like "xwhat/text" → navigate into xwhat first, then text
    const parts = tag.split('/');
    let currentXml = xml;

    for (let i = 0; i < parts.length - 1; i++) {
      const regex = new RegExp(`<${parts[i]}>([\\s\\S]*?)<\\/${parts[i]}>`);
      const m = regex.exec(currentXml);
      if (!m) return null;
      currentXml = m[1];
    }

    const finalTag = parts[parts.length - 1];
    const regex = new RegExp(`<${finalTag}>([^<]*)<\\/${finalTag}>`);
    const m = regex.exec(currentXml);
    return m ? m[1].trim() || null : null;
  }

  private safeInt(value: string | null): number | null {
    if (value === null) return null;
    const n = parseInt(value, 10);
    return isNaN(n) ? null : n;
  }

  summarizeValgrind(findings: Finding[]): string {
    const definitelyLost = findings.filter(
      (f) => f.aux?.leak?.kind === 'DefinitelyLost' || f.kind === 'DefinitelyLost',
    );
    const possiblyLost = findings.filter(
      (f) => f.aux?.leak?.kind === 'PossiblyLost' || f.kind === 'PossiblyLost',
    );

    const totalBytes = definitelyLost.reduce(
      (sum, f) => sum + (f.aux?.leak?.bytes || 0),
      0,
    );

    return `Definitely lost: ${definitelyLost.length} blocks, ${totalBytes} bytes. Possibly lost: ${possiblyLost.length}.`;
  }

  // ── ASan Parser ──

  parseAsanOutput(output: string): Finding[] {
    const findings: Finding[] = [];
    const lines = output.split('\n');

    const errorPatterns = [
      /ERROR: AddressSanitizer: (?<kind>.+)$/,
      /ERROR: LeakSanitizer: (?<kind>.+)$/,
    ];

    const framePattern = /#\d+\s+0x[0-9a-fA-F]+\s+in\s+(?<func>[^ ]+)(?:\s+(?<file>\/[^:]+):(?<line>\d+))?/;

    for (let i = 0; i < lines.length; i++) {
      let kind: string | null = null;
      let message: string | null = null;
      let matchedPattern: RegExp | null = null;

      for (const pat of errorPatterns) {
        pat.lastIndex = 0;
        const m = pat.exec(lines[i]);
        if (m?.groups) {
          kind = m.groups.kind.trim();
          message = lines[i].trim();
          matchedPattern = pat;
          break;
        }
      }

      if (!kind) continue;

      const stack: StackFrame[] = [];
      i++;
      while (i < lines.length) {
        const line = lines[i].trim();
        // Check if this line starts a new error
        let isNewError = false;
        for (const pat of errorPatterns) {
          pat.lastIndex = 0;
          if (pat.test(line)) {
            isNewError = true;
            break;
          }
        }
        if (isNewError) {
          i--; // back up so outer loop processes this line
          break;
        }

        if (line.startsWith('#')) {
          framePattern.lastIndex = 0;
          const fm = framePattern.exec(line);
          if (fm?.groups) {
            stack.push({
              function: fm.groups.func || null,
              file: fm.groups.file || null,
              line: this.safeInt(fm.groups.line),
            });
          }
        }
        i++;
      }

      findings.push({
        kind,
        message: message || kind,
        stack,
        originStack: [],
        aux: {},
      });
    }

    return findings;
  }

  // ── LSan Parser (same format as ASan for leak reports) ──

  parseLsanOutput(output: string): Finding[] {
    // LSan output uses same format as ASan
    return this.parseAsanOutput(output);
  }
}
