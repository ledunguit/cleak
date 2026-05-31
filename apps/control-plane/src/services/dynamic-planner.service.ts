import { Injectable, Logger } from '@nestjs/common';
import { DynamicMode, DynamicToolPreference } from '@mcpvul/common';

export interface DynamicPlan {
  targets: DynamicTarget[];
}

export interface DynamicTarget {
  tool: string;
  binaryPath: string;
  args: string[];
  priority: number;
}

@Injectable()
export class DynamicPlannerService {
  private readonly logger = new Logger(DynamicPlannerService.name);

  private get isMac(): boolean {
    return process.platform === 'darwin';
  }

  createPlan(
    bundles: any[],
    mode: DynamicMode,
    preference: DynamicToolPreference,
    binaryPath?: string,
    args?: string,
  ): DynamicPlan {
    const targets: DynamicTarget[] = [];

    if (!binaryPath) {
      return { targets };
    }

    const baseArgs = args ? args.split(' ').filter(Boolean) : [];
    const priorityBundles = bundles.filter((b) => b.candidate?.confidence === 'high');

    if (mode === DynamicMode.OFF) {
      return { targets };
    }

    // On macOS, skip Valgrind (not available) and use ASan + LSan instead
    if (this.isMac) {
      if (preference === DynamicToolPreference.AUTO) {
        this.logger.log('macOS detected: preferring ASan + LSan over Valgrind');
        targets.push({
          tool: 'asan.run',
          binaryPath,
          args: baseArgs,
          priority: 1,
        });
        targets.push({
          tool: 'lsan.run',
          binaryPath,
          args: baseArgs,
          priority: 2,
        });
      } else if (preference === DynamicToolPreference.VALGRIND) {
        // User explicitly asked for Valgrind — try anyway (might be Docker)
        targets.push({
          tool: 'valgrind.analyze_memcheck',
          binaryPath,
          args: baseArgs,
          priority: 1,
        });
      } else {
        targets.push({
          tool: `${preference}.run`,
          binaryPath,
          args: baseArgs,
          priority: 1,
        });
      }
    } else {
      // Linux — full Valgrind support
      if (preference === DynamicToolPreference.AUTO) {
        targets.push({
          tool: 'valgrind.analyze_memcheck',
          binaryPath,
          args: baseArgs,
          priority: 1,
        });
      } else {
        targets.push({
          tool: `${preference}.run`,
          binaryPath,
          args: baseArgs,
          priority: 1,
        });
      }
    }

    if (mode === DynamicMode.AGGRESSIVE && priorityBundles.length > 0) {
      // Avoid duplicate ASan run on macOS (already added above for AUTO)
      const hasAsan = targets.some(t => t.tool === 'asan.run');
      if (!hasAsan) {
        targets.push({
          tool: 'asan.run',
          binaryPath,
          args: baseArgs,
          priority: 2,
        });
      }
    }

    return { targets };
  }
}
