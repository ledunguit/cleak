import { Injectable, Logger } from '@nestjs/common';
import { execSync, execFileSync } from 'child_process';
import { existsSync, readdirSync, statSync, writeFileSync, realpathSync } from 'fs';
import { join } from 'path';
import type { BuildTargetResponse } from '../types/mcp-responses';

@Injectable()
export class BuildTargetService {
  private readonly logger = new Logger(BuildTargetService.name);

  async build(
    projectPath: string,
    buildCommand: string,
    timeoutSec?: number,
  ): Promise<BuildTargetResponse> {
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

    // Create a wrapper build script to capture output and binary path
    const buildScriptPath = join(projectPath, '.mcpvul_build.sh');

    // Adapt sanitizer flags for the host platform
    const adaptedCommand = this.adaptSanitizerFlags(buildCommand);
    if (adaptedCommand !== buildCommand) {
      this.logger.log(`Adapted build command for platform:\n  original: ${buildCommand}\n  adapted:  ${adaptedCommand}`);
    }

    // Determine if we should use Docker-based build (for macOS)
    const useDocker = this.shouldUseDockerBuild(adaptedCommand);

    if (useDocker) {
      return this.buildWithDocker(projectPath, adaptedCommand, timeout);
    }

    // Native build
    try {
      const buildLog = execSync(adaptedCommand, {
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const execErr = err as { stderr?: string; stdout?: string };
      errors.push(execErr.stderr || msg);
      return {
        success: false,
        binaryPath: '',
        buildLog: execErr.stdout || '',
        errors,
      };
    }
  }

  /**
   * Build using Docker for macOS where sanitizers may not work natively.
   */
  private async buildWithDocker(
    projectPath: string,
    buildCommand: string,
    timeoutSec: number,
  ) {
    const errors: string[] = [];
    const buildId = `build_${Date.now()}`;
    const containerWorkDir = '/workspace';

    // Write build command to a script
    const scriptContent = `#!/bin/sh
set -e
cd ${containerWorkDir}
${buildCommand}
echo "---BUILD_COMPLETE---"
`;
    writeFileSync(join(projectPath, '.mcpvul_docker_build.sh'), scriptContent);

    try {
      // Canonicalize the mount source so a crafted projectPath can't point the
      // bind-mount somewhere unexpected, and pass docker args as an array (no
      // shell) so the path can never inject a command.
      const mountSrc = realpathSync(projectPath);
      // Confine the build container: no network + bounded memory/processes, so an
      // untrusted build script can't exfiltrate or fork-bomb. Network is opt-in
      // (some real builds fetch deps) via DYNAMIC_BUILD_NETWORK.
      const network = process.env.DYNAMIC_BUILD_NETWORK || 'none';
      const dockerArgs = [
        'run', '--rm',
        '--network', network,
        '--memory', process.env.DYNAMIC_BUILD_MEMORY || '1g',
        '--pids-limit', process.env.DYNAMIC_BUILD_PIDS || '512',
        '-v', `${mountSrc}:${containerWorkDir}`,
        '-w', containerWorkDir,
        'gcc:latest',
        '/bin/sh', '.mcpvul_docker_build.sh',
      ];

      this.logger.log(`Docker build: docker ${dockerArgs.join(' ')}`);
      const output = execFileSync('docker', dockerArgs, {
        timeout: timeoutSec * 1000,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });

      // Find the binary inside the container volume mount
      const binaryPath = this.findBinary(projectPath, output);

      return {
        success: true,
        binaryPath: existsSync(binaryPath) ? binaryPath : '',
        buildLog: output,
        errors: [],
        docker: true,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const execErr = err as { stderr?: string; stdout?: string };
      errors.push(execErr.stderr || msg);
      return {
        success: false,
        binaryPath: '',
        buildLog: execErr.stdout || '',
        errors,
        docker: true,
      };
    } finally {
      // Cleanup build script
      try {
        const scriptFile = join(projectPath, '.mcpvul_docker_build.sh');
        if (existsSync(scriptFile)) require('fs').unlinkSync(scriptFile);
      } catch { /* ignore cleanup errors */ }
    }
  }

  /**
   * Decide whether to use Docker-based build.
   */
  private shouldUseDockerBuild(buildCommand: string): boolean {
    // Use Docker if:
    // 1. On macOS and build uses sanitizer flags (ASan/LSan don't work well natively on macOS)
    // 2. The build command has sanitizer flags that need Linux
    const isMac = process.platform === 'darwin';
    const hasSanitizer = buildCommand.includes('-fsanitize=');
    return isMac && hasSanitizer;
  }

  private findBinary(projectPath: string, buildLog: string): string {
    // Extract binary name from build log (after -o flag)
    const oMatch = buildLog.match(/-o\s+(\S+)/);
    if (oMatch) {
      const candidate = join(projectPath, oMatch[1]);
      if (existsSync(candidate) && isExecutable(candidate)) return candidate;
    }

    // Try common output names
    const candidates = ['a.out', 'build/app', 'build/target', 'target/app', 'simple_leak', 'vuln', 'test', 'leak-demo'];
    for (const candidate of candidates) {
      const fullPath = join(projectPath, candidate);
      if (existsSync(fullPath) && isExecutable(fullPath)) return fullPath;
    }

    // Recursive search for executables (depth 3)
    const recursiveMatch = this.findExecutableRecursive(projectPath, 3);

    // Also try looking for ELF files in build directories
    if (!recursiveMatch) {
      const buildDirs = ['build', 'bin', 'out', 'target', 'cmake-build-debug', 'cmake-build-release'];
      for (const dir of buildDirs) {
        const fullDir = join(projectPath, dir);
        if (existsSync(fullDir)) {
          const found = this.findExecutableRecursive(fullDir, 2);
          if (found) return found;
        }
      }
    }

    if (recursiveMatch) return recursiveMatch;

    // Fallback
    return join(projectPath, 'a.out');
  }

  private findExecutableRecursive(dir: string, maxDepth: number): string | null {
    if (maxDepth < 0) return null;

    try {
      for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
          if (entry === '.git' || entry === 'node_modules' || entry.startsWith('.')) continue;
          const nested = this.findExecutableRecursive(fullPath, maxDepth - 1);
          if (nested) return nested;
          continue;
        }

        if (isExecutable(fullPath)) return fullPath;
      }
    } catch {
      return null;
    }

    return null;
  }

  private adaptSanitizerFlags(buildCommand: string): string {
    const isMac = process.platform === 'darwin';
    if (!isMac) return buildCommand;

    // Replace -fsanitize=leak with -fsanitize=address on macOS
    // (LSan is part of ASan on macOS, not standalone)
    let adapted = buildCommand.replace(/-fsanitize=leak\b/g, '-fsanitize=address');

    // Also handle CMake variable settings
    adapted = adapted.replace(/CMAKE_C_FLAGS="[^"]*"/g, (match) => {
      return match.replace(/-fsanitize=leak/g, '-fsanitize=address');
    });
    adapted = adapted.replace(/CMAKE_CXX_FLAGS="[^"]*"/g, (match) => {
      return match.replace(/-fsanitize=leak/g, '-fsanitize=address');
    });

    // For Docker builds on macOS, don't need to adapt
    // (Docker uses Linux where LSan works natively)

    return adapted;
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
