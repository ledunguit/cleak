import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GitHubConnectionEntity, UserEntity } from '@mcpvul/common';
import { randomBytes } from 'crypto';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_BASE = 'https://api.github.com';

@Injectable()
export class GitHubService {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private cloneRoot: string;
  private pendingStates = new Map<string, number>();

  constructor(
    private config: ConfigService,
    @InjectRepository(GitHubConnectionEntity)
    private gitHubRepo: Repository<GitHubConnectionEntity>,
    @InjectRepository(UserEntity)
    private userRepo: Repository<UserEntity>,
  ) {
    this.clientId = config.get('GITHUB_CLIENT_ID', '');
    this.clientSecret = config.get('GITHUB_CLIENT_SECRET', '');
    this.redirectUri = config.get('GITHUB_REDIRECT_URI', 'http://localhost:5173/login');
    this.cloneRoot = config.get('GITHUB_CLONE_ROOT', '/tmp/mcpvul/clones');
    if (!existsSync(this.cloneRoot)) {
      mkdirSync(this.cloneRoot, { recursive: true });
    }
  }

  getAuthUrl(scope?: string) {
    const state = randomBytes(32).toString('hex');
    this.pendingStates.set(state, Date.now());
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: scope || 'public_repo,user:email',
      state,
    });
    return { authorization_url: `${AUTHORIZE_URL}?${params.toString()}`, state };
  }

  async handleCallback(code: string, state: string) {
    // Validate state
    const ts = this.pendingStates.get(state);
    if (!ts || (Date.now() - ts) > 300000) {
      return { success: false, error: 'Invalid or expired state' };
    }
    this.pendingStates.delete(state);

    // Exchange code for token
    const tokenData = await this.exchangeCode(code);
    if (!tokenData.access_token) {
      return { success: false, error: 'Failed to obtain access token' };
    }

    // Get user info
    const user = await this.githubApiRequest('/user', tokenData.access_token);

    // Fetch and cache all accessible repos (public repos by default,
    // or all repos including private if 'repo' scope was granted)
    const repoType = tokenData.scope?.includes('repo') ? 'all' : 'public';
    let cachedRepos: Record<string, any>[] = [];
    try {
      const repos = await this.githubApiPaginate(
        `/user/repos?type=${repoType}&per_page=100&sort=updated`,
        tokenData.access_token,
      );
      cachedRepos = repos.map((r: any) => ({
        id: r.id,
        full_name: r.full_name,
        clone_url: r.clone_url,
        private: r.private,
        default_branch: r.default_branch,
        description: r.description,
      }));
    } catch {
      // Non-critical — cache will be empty but connection still works
    }

    // Save connection with cached repos
    await this.saveConnection({
      githubUserId: user.id,
      login: user.login,
      avatarUrl: user.avatar_url,
      accessToken: tokenData.access_token,
      cachedRepos,
    });

    return { success: true, scope: tokenData.scope || '' };
  }

  async getStatus() {
    const conn = await this.getActiveConnection();
    if (!conn) return { connected: false, user: null };
    return {
      connected: true,
      user: {
        id: conn.githubUserId,
        login: conn.login,
        avatar_url: conn.avatarUrl,
      },
    };
  }

  async listRepos(type = 'all', refresh = false) {
    const conn = await this.getActiveConnection();
    if (!conn) return { repos: [] };

    // Return cached repos unless refresh is requested
    if (!refresh && conn.cachedRepos && conn.cachedRepos.length > 0) {
      const repos = type === 'all'
        ? conn.cachedRepos
        : conn.cachedRepos.filter((r) => type === 'private' ? r.private : !r.private);
      return { repos, cached: true };
    }

    // Fetch fresh from GitHub API
    const repos = await this.githubApiPaginate(
      `/user/repos?type=${type}&per_page=100&sort=updated`,
      conn.accessToken,
    );

    const mapped = repos.map((r: any) => ({
      id: r.id,
      full_name: r.full_name,
      clone_url: r.clone_url,
      private: r.private,
      default_branch: r.default_branch,
      description: r.description,
    }));

    // Update cache in background
    conn.cachedRepos = mapped;
    this.gitHubRepo.save(conn).catch(() => {});

    return { repos: mapped, cached: false };
  }

  async getCachedRepos() {
    const conn = await this.getActiveConnection();
    if (!conn) return { repos: [], scope: '' };

    let scope = 'public_repo';
    // Determine approximate scope from cached repos
    const hasPrivate = conn.cachedRepos?.some((r) => r.private) || false;
    if (hasPrivate) scope = 'repo';

    return { repos: conn.cachedRepos || [], scope };
  }

  getPrivateRepoAuthUrl(repoFullName: string) {
    const state = randomBytes(32).toString('hex');
    this.pendingStates.set(state, Date.now());
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: `${this.redirectUri}?private_repo=${encodeURIComponent(repoFullName)}`,
      scope: 'repo',
      state,
    });
    return { authorization_url: `${AUTHORIZE_URL}?${params.toString()}`, state };
  }

  async disconnect() {
    await this.gitHubRepo.clear();
    return { success: true };
  }

  async getAccessToken(userId?: string): Promise<string | null> {
    if (userId) {
      const user = await this.userRepo.findOneBy({ userId });
      return user?.accessToken || null;
    }
    const conn = await this.getActiveConnection();
    return conn?.accessToken || null;
  }

  async cloneRepo(
    repoFullName: string,
    cloneUrl: string,
    branch = 'main',
    userId?: string,
  ): Promise<string> {
    const token = userId
      ? await this.getAccessToken(userId)
      : await this.getAccessToken();
    if (!token) throw new Error('GitHub not connected');

    const localDir = `${this.cloneRoot}/${repoFullName}`;
    const authUrl = cloneUrl.replace('https://', `https://oauth2:${token}@`);

    try {
      if (existsSync(`${localDir}/.git`)) {
        execSync('git fetch origin', { cwd: localDir, timeout: 120000 });
        execSync(`git reset --hard origin/${branch}`, { cwd: localDir, timeout: 60000 });
      } else {
        execSync(
          `git clone --depth 1 --branch ${branch} ${authUrl} ${localDir}`,
          { timeout: 300000 },
        );
      }
    } catch (err: any) {
      // Never surface the embedded OAuth token in the error message / logs.
      const sanitized = String(err?.message || err)
        .split(token)
        .join('***')
        .replace(/oauth2:[^@\s]*@/g, 'oauth2:***@');
      throw new Error(sanitized);
    }

    return localDir;
  }

  async listBranches(owner: string, name: string) {
    const conn = await this.getActiveConnection();
    if (!conn) return { branches: [] };

    const branches = await this.githubApiPaginate(
      `/repos/${owner}/${name}/branches?per_page=100`,
      conn.accessToken,
    );

    return {
      branches: branches.map((b: any) => ({
        name: b.name,
        commit_sha: b.commit.sha,
      })),
    };
  }

  // ── Private helpers ──

  private async getActiveConnection(): Promise<GitHubConnectionEntity | null> {
    const conns = await this.gitHubRepo.find({ order: { createdAt: 'DESC' }, take: 1 });
    if (conns.length > 0) return conns[0];

    // Fallback: nếu user login qua AuthService, accessToken lưu trong UserEntity
    const users = await this.userRepo.find({ order: { createdAt: 'DESC' }, take: 1 });
    const user = users[0];
    if (!user?.accessToken) return null;

    // Tạo ephemeral connection object từ UserEntity (không save vào DB)
    return Object.assign(new GitHubConnectionEntity(), {
      id: 'ephemeral',
      githubUserId: user.githubUserId,
      login: user.login,
      avatarUrl: user.avatarUrl,
      accessToken: user.accessToken,
    });
  }

  private async exchangeCode(code: string): Promise<any> {
    const url = TOKEN_URL;
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.redirectUri,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });

    return response.json();
  }

  private async githubApiRequest(path: string, token: string): Promise<any> {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'mcp-vul/1.0',
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${text}`);
    }
    return response.json();
  }

  private async githubApiPaginate(path: string, token: string): Promise<any[]> {
    const results: any[] = [];
    let url: string | null = `${API_BASE}${path}`;

    while (url) {
      const response: Response = await fetch(url, {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'mcp-vul/1.0',
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`GitHub pagination error ${response.status}: ${text}`);
      }

      results.push(...(await response.json()));

      // Parse Link header for next page
      const headerLink = response.headers.get('link') || '';
      const nextPattern = /<([^>]+)>;\s*rel="next"/;
      const nextResult = nextPattern.exec(headerLink);
      url = nextResult ? nextResult[1] : null;
    }

    return results;
  }

  private async saveConnection(data: {
    githubUserId: number;
    login: string;
    avatarUrl?: string;
    accessToken: string;
    cachedRepos?: Record<string, any>[];
  }) {
    const existing = await this.gitHubRepo.findOneBy({ githubUserId: data.githubUserId });
    if (existing) {
      Object.assign(existing, data);
      return this.gitHubRepo.save(existing);
    }
    return this.gitHubRepo.save(this.gitHubRepo.create(data));
  }
}
