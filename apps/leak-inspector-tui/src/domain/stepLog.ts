/**
 * Builds a human-readable, step-by-step markdown log of the agent's
 * investigation from the raw AgentEvent stream: each turn, its thinking, what it
 * said, every tool call with its full input, and every result. Written to
 * results/<scanId>/steps.md for thesis traceability (the full machine-readable
 * record lives in transcript.json).
 */

import type { AgentEvent } from '@cleak/agent-core';
import { toolSource } from './mcpToolPlan';

const SOURCE_LABEL: Record<string, string> = {
  'mcp-static': 'MCP static-analyzer',
  'mcp-dynamic': 'MCP dynamic-analyzer',
  local: 'local',
};

export class StepLog {
  private lines: string[] = ['# Investigation steps', ''];

  record(ev: AgentEvent): void {
    switch (ev.type) {
      case 'turn_start':
        this.lines.push(`## Turn ${ev.turn}`, '');
        break;
      case 'notice':
        this.lines.push(`↻ _${oneLine(ev.text, 300)}_`, '');
        break;
      case 'paused':
        this.lines.push(`⏸ **paused** — ${oneLine(ev.reason, 200)} (awaiting user)`, '');
        break;
      case 'resumed':
        this.lines.push(`▶ **resumed** by user`, '');
        break;
      case 'thinking':
        if (ev.text.trim()) this.lines.push(`> 💭 **thinking:** ${oneLine(ev.text, 1200)}`, '');
        break;
      case 'assistant_text':
        if (ev.text.trim()) this.lines.push(`🗣 ${oneLine(ev.text, 1200)}`, '');
        break;
      case 'tool_use':
        this.lines.push(
          `🔧 **${ev.name}** _(${SOURCE_LABEL[toolSource(ev.name)]})_${ev.isReadOnly ? '' : ' (write)'} — input:`,
          fence(json(ev.input, 1500)),
        );
        break;
      case 'tool_result':
        this.lines.push(`${ev.isError ? '✗' : '↳'} result (${ev.durationMs}ms):`, fence(asText(ev.output, 2500)), '');
        break;
      case 'permission_request':
        this.lines.push(`🔐 permission requested: \`${ev.name}\``, '');
        break;
      case 'permission_decision':
        this.lines.push(`🔐 ${ev.name} → ${ev.decision}`, '');
        break;
      case 'error':
        this.lines.push(`⚠ **error:** ${oneLine(ev.message, 500)}`, '');
        break;
      case 'done':
        this.lines.push('', `_investigation ended: **${ev.reason}**${ev.message ? ` — ${oneLine(ev.message, 300)}` : ''}_`, '');
        break;
    }
  }

  toMarkdown(): string {
    return this.lines.join('\n');
  }
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function json(value: unknown, max: number): string {
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return s.length > max ? `${s.slice(0, max)}…[+${s.length - max} chars]` : s;
}

function asText(value: unknown, max: number): string {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value;
  return json(value, max);
}

function fence(body: string): string {
  return '```\n' + body + '\n```';
}
