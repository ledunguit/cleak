import { Injectable, Logger, OnApplicationBootstrap, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { readdirSync, statSync, existsSync, mkdirSync, unlinkSync, writeFileSync, createWriteStream, readFileSync, rmSync } from 'fs';
import { dirname, join, normalize, resolve, basename, extname, relative, sep } from 'path';
import * as unzipper from 'unzipper';
import {
  ScanEntity,
  WorkspaceEntity,
  RepositoryEntity,
  GitHubConnectionEntity,
} from '@mcpvul/common';
import { GitHubService } from './github.service';
import { BuildDiscoveryService } from './build-discovery.service';

@Injectable()
export class PersistenceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PersistenceService.name);

  private get corpusPath(): string {
    const demoRoot = resolve(process.cwd(), '../..', 'demo', 'memory_leak_corpus');
    const fallbackRoot = resolve(process.cwd(), 'demo', 'memory_leak_corpus');
    if (existsSync(demoRoot)) return resolve(demoRoot);
    if (existsSync(fallbackRoot)) return resolve(fallbackRoot);
    return '/workspace/demo/memory_leak_corpus';
  }

  private countCppFiles(dir: string): number {
    if (!existsSync(dir)) return 0;
    let count = 0;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
          if (statSync(fullPath).isDirectory()) {
            count += this.countCppFiles(fullPath);
          } else if (/\.(c|cpp|cc|cxx|h|hpp|hxx)$/i.test(entry)) {
            count++;
          }
        } catch {
          // skip unreadable entries
        }
      }
    } catch {
      // skip unreadable dirs
    }
    return count;
  }

  async onApplicationBootstrap() {
    const existing = await this.workspaceRepo.count();
    if (existing > 0) {
      this.logger.log(`Found ${existing} existing workspaces, skipping seed`);
      return;
    }

    const path = this.corpusPath;
    this.logger.log(`Seeding workspaces from ${path}`);

    const corpusCount = this.countCppFiles(path);
    await this.workspaceRepo.save(
      this.workspaceRepo.create({
        name: 'demo-corpus',
        path,
        source: 'filesystem',
      }),
    );
    await this.workspaceRepo.save(
      this.workspaceRepo.create({
        name: 'test-ws',
        path,
        source: 'filesystem',
      }),
    );

    this.logger.log(`Seeded 2 workspaces (${corpusCount} C/C++ files in corpus)`);
  }
  constructor(
    @InjectRepository(ScanEntity)
    private scanRepo: Repository<ScanEntity>,
    @InjectRepository(WorkspaceEntity)
    private workspaceRepo: Repository<WorkspaceEntity>,
    @InjectRepository(RepositoryEntity)
    private repoRepo: Repository<RepositoryEntity>,
    @InjectRepository(GitHubConnectionEntity)
    private gitHubRepo: Repository<GitHubConnectionEntity>,
    private gitHubService: GitHubService,
    private buildDiscovery: BuildDiscoveryService,
  ) {}

  // ── Workspaces ──

  async listWorkspaces() {
    const workspaces = await this.workspaceRepo.find({
      relations: { repos: true },
      order: { createdAt: 'DESC' },
    });
    return {
      workspaces: workspaces.map((w) => ({
        workspaceId: w.workspaceId,
        name: w.name,
        path: w.path,
        source: w.source,
        c_cpp_file_count: this.countCppFiles(w.path),
        settings: w.settings,
        createdAt: w.createdAt.toISOString(),
      })),
      allowed_roots: [this.corpusPath, '/workspace/demo/memory_leak_corpus'],
    };
  }

  async createWorkspace(name: string, path: string) {
    const resolvedPath = resolve(path);
    if (!existsSync(resolvedPath)) {
      mkdirSync(resolvedPath, { recursive: true });
    }

    const entity = this.workspaceRepo.create({ name, path: resolvedPath });
    const saved = await this.workspaceRepo.save(entity);
    return {
      workspaceId: saved.workspaceId,
      name: saved.name,
      path: saved.path,
      source: 'filesystem',
    };
  }

  async getWorkspace(id: string) {
    const ws = await this.workspaceRepo.findOne({
      where: { workspaceId: id },
      relations: { repos: true },
    });
    if (!ws) return null;
    return {
      workspaceId: ws.workspaceId,
      name: ws.name,
      path: ws.path,
      source: ws.source,
      settings: ws.settings,
      repos: ws.repos?.map((r) => ({
        repo_id: r.repoId,
        repo_full_name: r.repoFullName,
        clone_url: r.cloneUrl,
        default_branch: r.defaultBranch,
        is_private: r.isPrivate,
        local_clone_path: r.localClonePath,
        last_cloned_at: r.lastClonedAt,
      })),
      createdAt: ws.createdAt.toISOString(),
    };
  }

  async deleteWorkspace(id: string) {
    await this.workspaceRepo.delete(id);
    return { success: true };
  }

  async updateWorkspaceSettings(id: string, settings: Record<string, unknown>) {
    const ws = await this.workspaceRepo.findOneBy({ workspaceId: id });
    if (!ws) return { success: false };
    ws.settings = { ...(ws.settings || {}), ...settings };
    await this.workspaceRepo.save(ws);
    return { success: true };
  }

  // ── Repos ──

  async addRepo(
    workspaceId: string,
    dto: {
      github_repo_id: number;
      repo_full_name: string;
      clone_url: string;
      default_branch: string;
      is_private: boolean;
    },
  ) {
    const entity = this.repoRepo.create({
      workspaceId,
      githubRepoId: dto.github_repo_id,
      repoFullName: dto.repo_full_name,
      cloneUrl: dto.clone_url,
      defaultBranch: dto.default_branch,
      isPrivate: dto.is_private,
    });
    const saved = await this.repoRepo.save(entity);
    return { repo_id: saved.repoId };
  }

  async cloneRepo(workspaceId: string, repoId: string) {
    const repo = await this.repoRepo.findOneBy({ repoId, workspaceId });
    if (!repo) return { success: false, localClonePath: '' };

    let clonePath: string;
    if (repo.cloneUrl && repo.repoFullName) {
      // Real GitHub clone
      try {
        clonePath = await this.gitHubService.cloneRepo(
          repo.repoFullName,
          repo.cloneUrl,
          repo.defaultBranch || 'main',
        );
      } catch (err) {
        this.logger.error(`Clone failed for ${repo.repoFullName}: ${err}`);
        return { success: false, error: String(err) };
      }
    } else {
      // Filesystem path — just record it
      clonePath = `/tmp/mcpvul/${repoId}`;
    }

    repo.localClonePath = clonePath;
    repo.lastClonedAt = Math.floor(Date.now() / 1000);
    await this.repoRepo.save(repo);
    return { localClonePath: clonePath, success: true };
  }

  async detectBuild(workspaceId: string, repoId: string) {
    const repo = await this.repoRepo.findOneBy({ repoId, workspaceId });
    if (!repo) {
      throw new BadRequestException('Repository not found');
    }

    const plan = await this.buildDiscovery.discover({
      workspaceId,
      repoId,
      workspacePath: repo.localClonePath,
      preferLlm: true,
    });

    return {
      command: plan.buildCommand,
      plan,
    };
  }

  async addRepoByPath(workspaceId: string, path: string, name?: string) {
    const resolvedPath = resolve(path);
    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
      throw new BadRequestException('Local repository path must exist and be a directory');
    }

    const entity = this.repoRepo.create({
      workspaceId,
      repoFullName: name || path.split('/').pop() || path,
      cloneUrl: '',
      defaultBranch: '',
      isPrivate: false,
      localClonePath: resolvedPath,
    });
    const saved = await this.repoRepo.save(entity);
    return { repo_id: saved.repoId, local_clone_path: saved.localClonePath };
  }

  async addRepoFromZip(workspaceId: string, file: Express.Multer.File) {
    if (extname(file.originalname).toLowerCase() !== '.zip') {
      throw new BadRequestException('Only .zip files are accepted');
    }

    // Resolve extract target
    const ws = await this.workspaceRepo.findOneBy({ workspaceId });
    if (!ws) throw new BadRequestException('Workspace not found');

    const repoName = basename(file.originalname, '.zip');
    const extractDir = join(ws.path, repoName);
    mkdirSync(extractDir, { recursive: true });

    // Support both memory storage (buffer) and disk storage (path)
    let zipBuffer: Buffer;
    if (file.buffer && file.buffer.length > 0) {
      zipBuffer = file.buffer;
    } else if (file.path && existsSync(file.path)) {
      zipBuffer = readFileSync(file.path);
    } else {
      throw new BadRequestException('Could not read uploaded file');
    }

    // Extract the zip contents
    await this.extractZipSafely(zipBuffer, extractDir);

    // Create repo record
    const entity = this.repoRepo.create({
      workspaceId,
      repoFullName: repoName,
      cloneUrl: '',
      defaultBranch: '',
      isPrivate: false,
      localClonePath: extractDir,
    });
    const saved = await this.repoRepo.save(entity);

    this.logger.log(`Extracted ZIP "${file.originalname}" to ${extractDir}`);

    return {
      repo_id: saved.repoId,
      repo_full_name: repoName,
      local_clone_path: extractDir,
    };
  }

  async removeRepo(workspaceId: string, repoId: string) {
    await this.repoRepo.delete({ repoId, workspaceId });
    return { success: true };
  }


  /**
   * Clone a public repository by URL (no OAuth required).
   * Supports https://github.com/... and git@... URLs.
   */
  async cloneByPublicUrl(workspaceId: string, url: string, name?: string) {
    const ws = await this.workspaceRepo.findOneBy({ workspaceId });
    if (!ws) throw new BadRequestException('Workspace not found');

    const repoName = name || url.split('/').pop()?.replace(/\.git$/, '') || 'repo';
    const cloneDir = join(ws.path, repoName);

    if (existsSync(cloneDir)) {
      throw new BadRequestException(`Target directory already exists: ${cloneDir}. Remove it first or choose a different name.`);
    }

    mkdirSync(cloneDir, { recursive: true });

    try {
      const { execSync } = require('child_process');
      execSync(`git clone --depth 1 ${url} ${cloneDir}`, {
        timeout: 120000, // 2 min timeout
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    } catch (err: any) {
      // Cleanup on failure
      try { rmSync(cloneDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new BadRequestException(`Git clone failed: ${err.stderr || err.message}`);
    }

    const entity = this.repoRepo.create({
      workspaceId,
      repoFullName: repoName,
      cloneUrl: url,
      defaultBranch: 'main',
      isPrivate: false,
      localClonePath: cloneDir,
    });
    const saved = await this.repoRepo.save(entity);

    this.logger.log(`Cloned public repo ${url} to ${cloneDir}`);

    return {
      repo_id: saved.repoId,
      repo_full_name: repoName,
      local_clone_path: cloneDir,
      clone_url: url,
    };
  }

  // ── GitHub ──

  async findGitHubConnection(githubUserId: number) {
    return this.gitHubRepo.findOneBy({ githubUserId });
  }

  async saveGitHubConnection(data: {
    githubUserId: number;
    login: string;
    avatarUrl?: string;
    accessToken: string;
  }) {
    const existing = await this.gitHubRepo.findOneBy({ githubUserId: data.githubUserId });
    if (existing) {
      Object.assign(existing, data);
      return this.gitHubRepo.save(existing);
    }
    return this.gitHubRepo.save(this.gitHubRepo.create(data));
  }

  async deleteGitHubConnection(githubUserId: number) {
    await this.gitHubRepo.delete({ githubUserId });
  }

  private async extractZipSafely(zipBuffer: Buffer, extractDir: string): Promise<void> {
    const archive = await unzipper.Open.buffer(zipBuffer);
    for (const entry of archive.files) {
      const normalizedPath = normalize(entry.path).replace(/^(\.\.(\/|\\|$))+/, '');
      const destination = resolve(extractDir, normalizedPath);

      if (!this.isWithinRoot(destination, extractDir)) {
        throw new BadRequestException(`ZIP entry escapes extraction root: ${entry.path}`);
      }

      if (entry.type === 'Directory') {
        mkdirSync(destination, { recursive: true });
        continue;
      }

      if (!normalizedPath || normalizedPath.endsWith('/')) {
        continue;
      }

      mkdirSync(dirname(destination), { recursive: true });
      await new Promise<void>((resolveEntry, rejectEntry) => {
        entry.stream()
          .pipe(createWriteStream(destination))
          .on('finish', () => resolveEntry())
          .on('error', rejectEntry);
      });
    }
  }

  private isWithinRoot(candidatePath: string, rootPath: string): boolean {
    const rel = relative(resolve(rootPath), resolve(candidatePath));
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
  }

  // ── Scans ──

  async listScans() {
    return this.scanRepo.find({ order: { createdAt: 'DESC' } });
  }

  async createScan(data: Partial<ScanEntity>) {
    const entity = this.scanRepo.create(data);
    return this.scanRepo.save(entity);
  }

  async getScan(id: string) {
    return this.scanRepo.findOneBy({ scanId: id });
  }

  async updateScan(id: string, data: Partial<ScanEntity>) {
    await this.scanRepo.update(id, data as any);
    return this.scanRepo.findOneBy({ scanId: id });
  }

  async deleteScan(id: string) {
    await this.scanRepo.delete(id);
  }
}
