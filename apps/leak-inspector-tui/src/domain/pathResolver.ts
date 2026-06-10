/**
 * Translate between host paths (where the TUI reads source for snippets / repair
 * diffs) and analyzer-visible paths (what the MCP servers index). When the TUI
 * and the analyzers run on the same host over the same directory — the thesis
 * default — both roots are equal and translation is the identity. The roots
 * differ only when the analyzers run in a container with a mounted workspace.
 */

import { monorepoRoot } from './env';

export class PathResolver {
  constructor(
    private readonly hostRoot?: string,
    private readonly analyzerRoot?: string,
  ) {}

  /** True when an explicit host↔analyzer mapping is configured (not identity). */
  hasMapping(): boolean {
    return !!this.hostRoot && !!this.analyzerRoot;
  }

  /** analyzer-visible path → host path (for reading the real source file). */
  toHostPath(filePath: string): string {
    if (!filePath || !this.analyzerRoot || !this.hostRoot) return filePath;
    return filePath.startsWith(this.analyzerRoot)
      ? `${this.hostRoot}${filePath.slice(this.analyzerRoot.length)}`
      : filePath;
  }

  /** host path → analyzer-visible path (for passing a path to an MCP tool). */
  toAnalyzerPath(filePath: string): string {
    if (!filePath || !this.analyzerRoot || !this.hostRoot) return filePath;
    return filePath.startsWith(this.hostRoot)
      ? `${this.analyzerRoot}${filePath.slice(this.hostRoot.length)}`
      : filePath;
  }

  describe(): string {
    return this.hasMapping() ? `${this.hostRoot} → ${this.analyzerRoot}` : 'identity (host paths)';
  }
}

/**
 * Build the resolver for a scan. Static analysis is content-based (identity), but
 * dynamic analysis builds/runs code on the analyzer, so when dynamic is enabled
 * and no explicit roots are configured we default to mapping the monorepo root →
 * `/workspace` (the Docker mount), so the agent's host paths reach the analyzer.
 * Override with HOST_ROOT / ANALYZER_ROOT.
 */
export function buildPathResolver(opts: {
  hostRoot?: string;
  analyzerRoot?: string;
  dynamicEnabled: boolean;
  cwd: string;
}): PathResolver {
  let { hostRoot, analyzerRoot } = opts;
  if (opts.dynamicEnabled && !hostRoot && !analyzerRoot) {
    hostRoot = monorepoRoot(opts.cwd);
    analyzerRoot = '/workspace';
  }
  return new PathResolver(hostRoot, analyzerRoot);
}
