import { Injectable } from '@nestjs/common';
import { ToolExecutionRecord, ToolCost } from '@mcpvul/common';

export interface ToolRegistration<TArgs = any, TResult = any> {
  name: string;
  phase: string;
  description: string;
  typicalDurationMs: number;
  prerequisites: string[];
  providesEvidenceFor: string[];
  execute: (args: TArgs) => Promise<TResult>;
}

export interface ToolRegistryRun {
  register<TArgs, TResult>(tool: ToolRegistration<TArgs, TResult>): void;
  invoke<TResult = any>(toolName: string, args: any): Promise<TResult>;
  listTools(): Array<Pick<ToolRegistration, 'name' | 'phase' | 'description' | 'typicalDurationMs' | 'prerequisites' | 'providesEvidenceFor'>>;
  getExecutionRecords(): ToolExecutionRecord[];
  getTool(name: string): ToolRegistration | undefined;
  hasExecuted(toolName: string): boolean;
  getSuccessfulToolNames(): string[];
}

@Injectable()
export class ToolRegistryService {
  createRun(): ToolRegistryRun {
    const tools = new Map<string, ToolRegistration>();
    const executionRecords: ToolExecutionRecord[] = [];

    return {
      register<TArgs, TResult>(tool: ToolRegistration<TArgs, TResult>) {
        tools.set(tool.name, tool as ToolRegistration);
      },

      getTool(name: string) {
        return tools.get(name);
      },

      hasExecuted(toolName: string): boolean {
        return executionRecords.some(
          (r) => r.toolName === toolName && r.status === 'success',
        );
      },

      getSuccessfulToolNames(): string[] {
        return executionRecords
          .filter((r) => r.status === 'success')
          .map((r) => r.toolName);
      },

      async invoke<TResult = any>(toolName: string, args: any): Promise<TResult> {
        const tool = tools.get(toolName);
        const startedAt = new Date().toISOString();
        const started = Date.now();

        if (!tool) {
          const completedAt = new Date().toISOString();
          executionRecords.push({
            toolName,
            phase: 'unknown',
            status: 'failed',
            startedAt,
            completedAt,
            durationMs: Date.now() - started,
            inputSummary: summarizePayload(args),
            error: 'Tool not registered',
          });
          throw new Error(`Tool not registered: ${toolName}`);
        }

        try {
          const result = await tool.execute(args);
          executionRecords.push({
            toolName,
            phase: tool.phase,
            status: 'success',
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - started,
            inputSummary: summarizePayload(args),
            outputSummary: summarizePayload(result),
          });
          return result as TResult;
        } catch (err: any) {
          executionRecords.push({
            toolName,
            phase: tool.phase,
            status: 'failed',
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - started,
            inputSummary: summarizePayload(args),
            error: err.message || String(err),
          });
          throw err;
        }
      },

      listTools() {
        return Array.from(tools.values()).map(
          ({ name, phase, description, typicalDurationMs, prerequisites, providesEvidenceFor }) => ({
            name,
            phase,
            description,
            typicalDurationMs,
            prerequisites,
            providesEvidenceFor,
          }),
        );
      },

      getExecutionRecords() {
        return executionRecords;
      },
    };
  }
}

function summarizePayload(payload: any): Record<string, unknown> {
  if (payload == null) return {};
  if (Array.isArray(payload)) return { itemCount: payload.length };
  if (typeof payload !== 'object') return { value: String(payload).slice(0, 200) };

  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload).slice(0, 12)) {
    if (Array.isArray(value)) {
      summary[key] = `${value.length} item(s)`;
    } else if (value && typeof value === 'object') {
      summary[key] = `${Object.keys(value).length} field(s)`;
    } else if (typeof value === 'string') {
      summary[key] = value.length > 120 ? `${value.slice(0, 117)}...` : value;
    } else {
      summary[key] = value as any;
    }
  }
  return summary;
}
