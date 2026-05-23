import { Injectable } from '@nestjs/common';
import { execSync } from 'child_process';

@Injectable()
export class LeakGuardAdapterService {
  async run(
    projectPath: string,
    buildCommand: string,
    timeoutSec?: number,
  ) {
    const timeout = timeoutSec || 300;
    const runId = `lg_${Date.now()}`;

    try {
      const output = execSync(
        `docker run --rm -v "${projectPath}:/project" leakguard-tool:dev /bin/sh -c "cd /project && ${buildCommand}"`,
        {
          timeout: timeout * 1000,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      return {
        success: true,
        runId,
        output,
      };
    } catch (err: any) {
      return {
        success: false,
        runId,
        output: err.stderr || err.message,
      };
    }
  }

  async getReport(runId: string) {
    // TODO: Implement report retrieval from LeakGuard output storage
    return {
      report: '',
      findings: [],
    };
  }
}
