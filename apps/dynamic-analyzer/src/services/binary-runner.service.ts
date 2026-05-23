import { Injectable } from '@nestjs/common';
import { execSync } from 'child_process';

@Injectable()
export class BinaryRunnerService {
  async run(
    binaryPath: string,
    args: string[],
    timeoutSec?: number,
  ) {
    const timeout = timeoutSec || 60;

    try {
      const stdout = execSync(
        `${binaryPath} ${args.join(' ')}`,
        {
          timeout: timeout * 1000,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      return {
        success: true,
        stdout,
        stderr: '',
        exitCode: 0,
      };
    } catch (err: any) {
      return {
        success: err.status === 0,
        stdout: err.stdout || '',
        stderr: err.stderr || err.message,
        exitCode: err.status || -1,
      };
    }
  }
}
