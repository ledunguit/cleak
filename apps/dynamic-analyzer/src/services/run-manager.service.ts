import { Injectable } from '@nestjs/common';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

interface RunRecord {
  runId: string;
  tool: string;
  binaryPath: string;
  output: string;
  findings: any[];
  success: boolean;
  createdAt: string;
}

@Injectable()
export class RunManagerService {
  private runsDir = process.env.RUNS_DIR || './runs';

  constructor() {
    if (!existsSync(this.runsDir)) {
      mkdirSync(this.runsDir, { recursive: true });
    }
  }

  saveRun(runId: string, data: Partial<RunRecord>): void {
    const record: RunRecord = {
      runId,
      tool: data.tool || 'unknown',
      binaryPath: data.binaryPath || '',
      output: data.output || '',
      findings: data.findings || [],
      success: data.success || false,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(this.runsDir, `${runId}.json`), JSON.stringify(record, null, 2));
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const filePath = join(this.runsDir, `${runId}.json`);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  }

  async listRuns(tool?: string, limit?: number) {
    const files = readdirSync(this.runsDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => join(this.runsDir, file));

    const runs = files
      .map((filePath) => {
        try {
          return JSON.parse(readFileSync(filePath, 'utf-8')) as RunRecord;
        } catch {
          return null;
        }
      })
      .filter((run): run is RunRecord => Boolean(run))
      .filter((run) => !tool || run.tool === tool)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit || 50)
      .map((run) => ({
        runId: run.runId,
        tool: run.tool,
        binaryPath: run.binaryPath,
        createdAt: run.createdAt,
        success: run.success,
      }));

    return { runs };
  }
}
