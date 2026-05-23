import { AnalysisMode, DynamicMode, DynamicToolPreference } from '../types/leak-schema.types';

export class CreateWorkspaceDto {
  name: string;
  path: string;
  source?: 'filesystem' | 'github';
  repoId?: string;
  settings?: WorkspaceSettingsDto;
}

export class WorkspaceSettingsDto {
  analysisMode?: AnalysisMode;
  dynamicMode?: DynamicMode;
  fileLimit?: number;
  buildCommand?: string;
  dynamicToolPreference?: DynamicToolPreference;
  lsanEnabled?: boolean;
}

export class UpdateWorkspaceSettingsDto {
  settings: WorkspaceSettingsDto;
}

export class WorkspaceResponseDto {
  workspaceId: string;
  name: string;
  path: string;
  c_cpp_file_count: number;
  source: string;
  repoId?: string;
  settings?: WorkspaceSettingsDto;
  createdAt: string;
}

export class WorkspaceListResponseDto {
  workspaces: WorkspaceResponseDto[];
  allowed_roots: string[];
}

// ── Repository DTOs ──

export class AddRepoDto {
  github_repo_id: number;
  repo_full_name: string;
  clone_url: string;
  default_branch: string;
  is_private: boolean;
}

export class RepoResponseDto {
  repo_id: string;
  github_repo_id?: number;
  repo_full_name: string;
  clone_url: string;
  default_branch: string;
  is_private: boolean;
  local_clone_path?: string;
  last_cloned_at?: number;
  created_at: string;
}

export class CloneRepoResponseDto {
  local_clone_path: string;
  success: boolean;
}

export class DetectBuildResponseDto {
  command: string;
}
