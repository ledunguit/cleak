export class GitHubAuthUrlDto {
  authUrl: string;
  state: string;
}

export class GitHubCallbackDto {
  code: string;
  state: string;
}

export class GitHubStatusDto {
  connected: boolean;
  user?: GitHubUserDto;
}

export class GitHubUserDto {
  id: number;
  login: string;
  avatar_url: string;
  name?: string;
}

export class GitHubRepoDto {
  id: number;
  full_name: string;
  clone_url: string;
  private: boolean;
  default_branch: string;
  description?: string;
}

export class GitHubBranchDto {
  name: string;
  commit_sha: string;
}
