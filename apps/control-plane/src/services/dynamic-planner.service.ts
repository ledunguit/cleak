import { Injectable } from '@nestjs/common';
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

    if (mode === DynamicMode.AGGRESSIVE && priorityBundles.length > 0) {
      targets.push({
        tool: 'asan.run',
        binaryPath,
        args: baseArgs,
        priority: 2,
      });
    }

    return { targets };
  }
}
