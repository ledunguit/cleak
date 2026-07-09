import type { AnalysisMode, DynamicMode, DynamicToolPreference } from './enums';

// ── GitHub ──

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
  name?: string;
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  clone_url: string;
  private: boolean;
  default_branch: string;
  description?: string;
}

export interface GitHubBranch {
  name: string;
  commit_sha: string;
}

// ── Workspace ──

export interface WorkspaceInfo {
  workspaceId: string;
  name: string;
  path: string;
  c_cpp_file_count: number;
  source: 'filesystem' | 'github';
  repoId?: string;
  settings?: WorkspaceSettings;
  createdAt: string;
}

export interface WorkspaceSettings {
  analysisMode?: AnalysisMode;
  dynamicMode?: DynamicMode;
  fileLimit?: number;
  buildCommand?: string;
  dynamicToolPreference?: DynamicToolPreference;
  lsanEnabled?: boolean;
}

// ── Build & Repository ──

export interface BuildPlanEvidence {
  kind: 'build_file' | 'ci_file' | 'readme' | 'heuristic' | 'llm';
  path?: string;
  detail: string;
}

export interface RepositoryManifest {
  scanId?: string;
  materializedWorkspaceId?: string;
  workspaceId?: string | null;
  repoId?: string | null;
  sourceType: 'github' | 'upload_zip' | 'local_path' | 'workspace_path';
  sourcePath: string;
  materializedPath: string;
  analyzerVisiblePath?: string;
  createdAt: string;
  rootEntries: string[];
  buildFiles: string[];
  ciFiles: string[];
  readmeFiles: string[];
  sourceFileCount: number;
  languageHints: string[];
}

export interface BuildPlan {
  buildSystem: string;
  workingDirectory: string;
  configureCommand?: string;
  buildCommand: string;
  cleanCommand?: string;
  runCommand?: string;
  binaryCandidates: string[];
  compilerOverrides: Record<string, string>;
  sanitizerVariants: {
    default: string;
    asan?: string;
    lsan?: string;
    valgrind?: string;
  };
  requiredEnv: Record<string, string>;
  evidence: BuildPlanEvidence[];
  strategy: 'heuristic' | 'llm' | 'user';
}
