// Workspace and GitHub types

export interface Workspace {
  workspaceId: string;
  name: string;
  path: string;
  source?: string;
  c_cpp_file_count?: number;
  settings?: Record<string, any>;
  createdAt?: string;
}

export interface WorkspaceDetail {
  workspaceId: string;
  name: string;
  path: string;
  source?: string;
  settings?: Record<string, any>;
  repos: Repo[];
  c_cpp_file_count?: number;
  createdAt?: string;
}

export interface Repo {
  repo_id: string;
  repo_full_name: string;
  clone_url: string;
  default_branch: string;
  is_private: boolean;
  local_clone_path?: string;
  last_cloned_at?: number;
  created_at?: string;
}

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
  name?: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  clone_url: string;
  default_branch: string;
  private: boolean;
}

export interface Branch {
  name: string;
  commit_sha: string;
}

export interface GitHubStatusResponse {
  connected: boolean;
  user?: GitHubUser;
  authorization_url?: string;
}

export interface CreateWorkspacePayload {
  name: string;
  path?: string;
}
