import { Injectable } from '@nestjs/common';
import { RunManagerService } from './run-manager.service';

@Injectable()
export class CompareService {
  constructor(private readonly runManager: RunManagerService) {}

  async compareValgrindRuns(runIdA: string, runIdB: string) {
    const runA = await this.runManager.getRun(runIdA);
    const runB = await this.runManager.getRun(runIdB);

    if (!runA || !runB) {
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

    return { newFindings, fixedFindings, unchanged };
  }

  private findingKey(finding: any): string {
    return `${finding.functionName || ''}:${finding.filePath || ''}:${finding.lineNumber || 0}`;
  }
}
