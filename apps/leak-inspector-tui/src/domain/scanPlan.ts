import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ScanPlanStep {
  id: string;
  label: string;
  detail: string;
  optional: boolean;
  skipped: boolean;
}

export interface ScanPlan {
  steps: ScanPlanStep[];
  mandatoryCount: number;
  optionalCount: number;
}

/**
 * Quick heuristic scan plan for a repo path.
 * - Counts C/C++ files
 * - Checks for build system (Makefile, CMakeLists.txt)
 * - Generates steps based on mode and dynamic settings
 */
export function generateScanPlan(
  repoPath: string,
  mode: string,
  dynamic: string,
): ScanPlan {
  const files = countCFiles(repoPath);
  const hasBuild = hasBuildSystem(repoPath);
  const isDynamic = dynamic !== 'off';

  const steps: ScanPlanStep[] = [
    {
      id: 'workspace',
      label: 'Discover workspace',
      detail: `Scan ${repoPath}`,
      optional: false,
      skipped: false,
    },
    {
      id: 'index',
      label: 'Index files',
      detail: `~${files} C/C++ files`,
      optional: false,
      skipped: false,
    },
    {
      id: 'candidates',
      label: 'Candidate scan',
      detail: `Find allocation sites`,
      optional: false,
      skipped: false,
    },
    {
      id: 'enrichment',
      label: 'Static enrichment',
      detail: `Alloc→free pairs + feasible paths`,
      optional: false,
      skipped: false,
    },
    {
      id: 'investigation',
      label: 'Agentic investigation',
      detail: mode === 'llm_assisted' ? 'LLM sub-agents gather evidence' : 'Heuristic only (no LLM)',
      optional: false,
      skipped: mode !== 'llm_assisted',
    },
    {
      id: 'dynamic',
      label: 'Dynamic analysis',
      detail: isDynamic
        ? hasBuild
          ? `Build + sanitizers (build system found)`
          : `No build system found — dynamic may be skipped`
        : 'Off',
      optional: true,
      skipped: !isDynamic || !hasBuild,
    },
    {
      id: 'judging',
      label: 'Judging',
      detail: mode === 'llm_assisted' ? 'Heuristic + LLM for borderline' : 'Heuristic only',
      optional: false,
      skipped: false,
    },
    {
      id: 'reporting',
      label: 'Reporting',
      detail: 'JSON + Markdown + Snapshot',
      optional: false,
      skipped: false,
    },
  ];

  return {
    steps,
    mandatoryCount: steps.filter((s) => !s.optional && !s.skipped).length,
    optionalCount: steps.filter((s) => s.optional && !s.skipped).length,
  };
}

function countCFiles(dir: string): number {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    let count = 0;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        count += countCFiles(join(dir, e.name));
      } else if (
        e.isFile() &&
        /\.(c|cc|cpp|cxx|h|hpp)$/i.test(e.name)
      ) {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function hasBuildSystem(dir: string): boolean {
  try {
    const entries = readdirSync(dir);
    return entries.some((f) =>
      /^(Makefile|CMakeLists\.txt|\.\w+project|build\.json)$/i.test(f),
    );
  } catch {
    return false;
  }
}
