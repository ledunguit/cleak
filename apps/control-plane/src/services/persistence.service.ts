import { Injectable, Logger, OnApplicationBootstrap, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { readdirSync, statSync, existsSync, mkdirSync, unlinkSync, createReadStream, writeFileSync } from 'fs';
import { join, resolve, basename, extname } from 'path';
import * as unzipper from 'unzipper';
import {
  ScanEntity,
  WorkspaceEntity,
  RepositoryEntity,
  GitHubConnectionEntity,
} from '@mcpvul/common';
import { GitHubService } from './github.service';

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
    const entity = this.workspaceRepo.create({ name, path });
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
    // Simple heuristic detection; LLM version added later
    return { command: 'make CC=clang' };
  }

  async addRepoByPath(workspaceId: string, path: string, name?: string) {
    const entity = this.repoRepo.create({
      workspaceId,
      repoFullName: name || path.split('/').pop() || path,
      cloneUrl: '',
      defaultBranch: '',
      isPrivate: false,
      localClonePath: path,
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

    // Write uploaded file to temp path
    const tmpPath = join(extractDir, `__upload_${Date.now()}.zip`);
    try {
      writeFileSync(tmpPath, file.buffer);

      // Extract ZIP
      await new Promise<void>((resolve2, reject) => {
        const stream = createReadStream(tmpPath);
        stream.pipe(unzipper.Extract({ path: extractDir }))
          .on('close', () => resolve2())
          .on('error', reject);
      });

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
    } finally {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  async removeRepo(workspaceId: string, repoId: string) {
    await this.repoRepo.delete({ repoId, workspaceId });
    return { success: true };
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
