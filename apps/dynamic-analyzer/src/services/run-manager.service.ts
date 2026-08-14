import { Injectable, Logger } from '@nestjs/common';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { ServerEventName } from '@cleak/common/mcp/server-events';
import { sanitizeRunId } from './safe-exec';

export interface RunRecord {
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
  private readonly logger = new Logger(RunManagerService.name);
  private runsDir = process.env.RUNS_DIR || './runs';

  constructor() {
    if (!existsSync(this.runsDir)) {
      mkdirSync(this.runsDir, { recursive: true });
    }
  }

  saveRun(runId: string, data: Partial<RunRecord>): void {
    // runId reaches the filesystem as a filename — sanitize to [A-Za-z0-9_] so
    // a crafted id can never traverse out of RUNS_DIR (SECURITY.md).
    const id = sanitizeRunId(runId, 'run');
    const record: RunRecord = {
      runId: id,
      tool: data.tool || 'unknown',
      binaryPath: data.binaryPath || '',
      output: data.output || '',
      findings: data.findings || [],
      success: data.success || false,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(this.runsDir, `${id}.json`), JSON.stringify(record, null, 2));
    this.logger.log({ event: ServerEventName.RUN_SAVED, runId: id, tool: record.tool }, 'run saved');
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    // Same sanitization on READ: valgrindGetReport/valgrindListFindings/
    // valgrindCompareRuns pass a caller-supplied runId that previously reached
    // join(runsDir, `${runId}.json`) unsanitized — a `../..` id could read an
    // arbitrary *.json file outside RUNS_DIR.
    const id = sanitizeRunId(runId, 'run');
    const filePath = join(this.runsDir, `${id}.json`);
    if (!existsSync(filePath)) {
      this.logger.warn({ event: ServerEventName.RUN_READ, runId: id, found: false }, 'run not found');
      return null;
    }
    this.logger.log({ event: ServerEventName.RUN_READ, runId: id, found: true }, 'run read');
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
          this.logger.warn({ event: ServerEventName.RUN_READ_CORRUPT, filePath }, 'corrupt run file, skipped');
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

    this.logger.log({ event: ServerEventName.RUNS_LISTED, tool, runCount: runs.length }, 'runs listed');
    return { runs };
  }
}
