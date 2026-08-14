import { Injectable, Logger } from '@nestjs/common';
import { ServerEventName } from '@cleak/common/mcp/server-events';
import { RunManagerService } from './run-manager.service';

@Injectable()
export class CompareService {
  private readonly logger = new Logger(CompareService.name);

  constructor(private readonly runManager: RunManagerService) {}

  async compareValgrindRuns(runIdA: string, runIdB: string) {
    this.logger.log({ event: ServerEventName.RUN_COMPARE_STARTED, runIdA, runIdB }, 'run compare started');
    const runA = await this.runManager.getRun(runIdA);
    const runB = await this.runManager.getRun(runIdB);

    if (!runA || !runB) {
      this.logger.warn({ event: ServerEventName.RUN_COMPARE_FINISHED, runIdA, runIdB, missing: true }, 'run compare: one or both runs not found');
      return {
        newFindings: [],
        fixedFindings: [],
        unchanged: [],
      };
    }

    const findingsA = new Map(
      (runA.findings || []).map((f: any) => [this.findingKey(f), f]),
    );
    const findingsB = new Map(
      (runB.findings || []).map((f: any) => [this.findingKey(f), f]),
    );

    const newFindings: any[] = [];
    const fixedFindings: any[] = [];
    const unchanged: any[] = [];

    for (const [key, finding] of findingsB) {
      if (!findingsA.has(key)) {
        newFindings.push(finding);
      } else {
        unchanged.push(finding);
      }
    }

    for (const [key, finding] of findingsA) {
      if (!findingsB.has(key)) {
        fixedFindings.push(finding);
      }
    }

    this.logger.log(
      { event: ServerEventName.RUN_COMPARE_FINISHED, runIdA, runIdB, newCount: newFindings.length, fixedCount: fixedFindings.length, unchangedCount: unchanged.length },
      'run compare finished',
    );
    return { newFindings, fixedFindings, unchanged };
  }

  private findingKey(finding: any): string {
    return `${finding.functionName || ''}:${finding.filePath || ''}:${finding.lineNumber || 0}`;
  }
}
