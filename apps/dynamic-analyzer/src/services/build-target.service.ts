import { Injectable } from '@nestjs/common';
import { execSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

@Injectable()
export class BuildTargetService {
  async build(
    projectPath: string,
    buildCommand: string,
    timeoutSec?: number,
  ) {
    const timeout = timeoutSec || 300;
    const errors: string[] = [];

    if (!existsSync(projectPath)) {
      return {
        success: false,
        binaryPath: '',
        buildLog: '',
        errors: [`Project path does not exist: ${projectPath}`],
      };
    }

    try {
      const buildLog = execSync(buildCommand, {
        cwd: projectPath,
        timeout: timeout * 1000,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });

      const binaryPath = this.findBinary(projectPath, buildLog);

      return {
        success: true,
        binaryPath: existsSync(binaryPath) ? binaryPath : '',
        buildLog,
        errors: [],
      };
    } catch (err: any) {
      errors.push(err.stderr || err.message);
      return {
        success: false,
        binaryPath: '',
        buildLog: err.stdout || '',
        errors,
      };
    }
  }

  private findBinary(projectPath: string, buildLog: string): string {
    // First try to extract binary name from build log (after -o flag)
    const oMatch = buildLog.match(/-o\s+(\S+)/);
    if (oMatch) {
      const candidate = join(projectPath, oMatch[1]);
      if (existsSync(candidate) && isExecutable(candidate)) return candidate;
    }

    // Try common output names
    const candidates = ['a.out', 'build/app', 'build/target', 'target/app', 'simple_leak', 'vuln', 'test'];
    for (const candidate of candidates) {
      const fullPath = join(projectPath, candidate);
      if (existsSync(fullPath) && isExecutable(fullPath)) return fullPath;
    }

    // Scan for any ELF binary in the project root
    try {
      for (const entry of readdirSync(projectPath)) {
        const fullPath = join(projectPath, entry);
        if (isExecutable(fullPath)) return fullPath;
      }
    } catch {
      // ignore scan errors
    }

    // Fallback
    return join(projectPath, 'a.out');
  }
}

function isExecutable(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
