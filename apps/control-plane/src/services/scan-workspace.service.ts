import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RepositoryEntity, RepositoryManifest } from '@mcpvul/common';
import { GitHubService } from './github.service';
import {
  Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  copyFileSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join, relative, resolve, sep } from 'path';

export interface MaterializedScanWorkspace {
  sourcePath: string;
  materializedPath: string;
  analyzerVisiblePath: string;
  materializedWorkspaceId: string;
  sourceType: 'github' | 'upload_zip' | 'local_path' | 'workspace_path';
  repoId?: string;
  workspaceId?: string;
  manifestPath: string;
  manifest: RepositoryManifest;
}

@Injectable()
export class ScanWorkspaceService {
  private readonly logger = new Logger(ScanWorkspaceService.name);

  constructor(
    @InjectRepository(RepositoryEntity)
    private readonly repoRepo: Repository<RepositoryEntity>,
    private readonly config: ConfigService,
    private readonly gitHubService: GitHubService,
  ) {}

  async materializeForScan(args: {
    scanId: string;
    workspacePath: string;
    workspaceId?: string;
    repoId?: string;
    sourceType?: 'github' | 'upload_zip' | 'local_path' | 'workspace_path';
  }): Promise<MaterializedScanWorkspace> {
    // Resolve the repo from the DB by repoId (workspaceId narrows it when present).
    // This is the authoritative source — never trust a transient client path when a
    // repo is selected, since the clone lives in the control-plane's filesystem.
    const repo = args.repoId
      ? await this.repoRepo.findOneBy(
          args.workspaceId ? { repoId: args.repoId, workspaceId: args.workspaceId } : { repoId: args.repoId },
        )
      : null;

    let candidatePath = repo?.localClonePath || args.workspacePath || '';

    // Clone-on-scan safety net: if a GitHub repo is selected but its clone is
    // missing on disk (never cloned, or stale path from a previous environment),
    // (re)clone it now so the scan can proceed instead of failing with a 400.
    const cloneMissing = !candidatePath || !existsSync(resolve(candidatePath)) || !lstatSync(resolve(candidatePath)).isDirectory();
    if (repo && repo.cloneUrl && repo.repoFullName && (!repo.localClonePath || cloneMissing)) {
      try {
        this.logger.log(`Repository ${repo.repoFullName} is not available locally; cloning before scan`);
        const cloned = await this.gitHubService.cloneRepo(repo.repoFullName, repo.cloneUrl, repo.defaultBranch || 'main');
        repo.localClonePath = cloned;
        repo.lastClonedAt = Math.floor(Date.now() / 1000);
        await this.repoRepo.save(repo);
        candidatePath = cloned;
      } catch (err: any) {
        throw new BadRequestException(
          `Repository "${repo.repoFullName}" is not cloned locally and an automatic clone failed: ${err?.message || err}. ` +
            'If it is a private/GitHub repository, make sure GitHub is connected.',
        );
      }
    }

    const sourcePath = resolve(candidatePath || '');
    if (!candidatePath || !existsSync(sourcePath) || !lstatSync(sourcePath).isDirectory()) {
      const reason = repo
        ? `Repository "${repo.repoFullName}" may not be cloned yet (resolved path: "${sourcePath}").`
        : args.repoId
          ? `Repository ${args.repoId} was not found.`
          : 'No repository was selected and the provided workspace path is missing or invalid. ' +
            'Add or clone a repository to the workspace, or provide a valid local directory path.';
      throw new BadRequestException(`Scan source path must exist and be a directory. ${reason}`);
    }

    const materializedWorkspaceId = `scan-${args.scanId}`;
    const materializedPath = join(this.scanWorkspaceRoot, materializedWorkspaceId, basename(sourcePath));
    const analyzerVisiblePath = join(this.analyzerWorkspaceRoot, materializedWorkspaceId, basename(sourcePath));
    const manifestPath = join(dirname(materializedPath), 'manifest.json');

    rmSync(dirname(materializedPath), { recursive: true, force: true });
    mkdirSync(materializedPath, { recursive: true });

    this.copyDirectory(sourcePath, materializedPath, sourcePath);

    const sourceType: MaterializedScanWorkspace['sourceType'] = args.sourceType || (
      repo?.cloneUrl
        ? 'github'
        : repo?.repoId
          ? 'local_path'
          : 'workspace_path'
    );

    const manifest = this.buildManifest({
      scanId: args.scanId,
      materializedWorkspaceId,
      workspaceId: args.workspaceId || null,
      repoId: args.repoId || null,
      sourceType,
      sourcePath,
      materializedPath,
      analyzerVisiblePath,
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    this.logger.log(`Materialized scan workspace ${materializedWorkspaceId} from ${sourcePath} to ${materializedPath}`);

    return {
      sourcePath,
      materializedPath,
      analyzerVisiblePath,
      materializedWorkspaceId,
      sourceType,
      repoId: args.repoId,
      workspaceId: args.workspaceId,
      manifestPath,
      manifest,
    };
  }

  private get scanWorkspaceRoot(): string {
    const configured = this.config.get<string>('SCAN_WORKSPACE_ROOT');
    return resolve(configured || join(process.cwd(), 'targets', 'scan-workspaces'));
  }

  private get analyzerWorkspaceRoot(): string {
    const configured = this.config.get<string>('SCAN_WORKSPACE_ANALYZER_ROOT');
    return configured || this.scanWorkspaceRoot;
  }

  cleanupForScan(scanId: string): { removed: boolean; path: string } {
    const path = join(this.scanWorkspaceRoot, `scan-${scanId}`);
    if (!existsSync(path)) {
      return { removed: false, path };
    }

    rmSync(path, { recursive: true, force: true });
    this.logger.log(`Removed materialized scan workspace for ${scanId}: ${path}`);
    return { removed: true, path };
  }

  private copyDirectory(sourceDir: string, targetDir: string, sourceRoot: string) {
    mkdirSync(targetDir, { recursive: true });
    const entries = readdirSync(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      if (this.shouldSkipEntry(entry)) continue;

      const sourceEntry = join(sourceDir, entry.name);
      const targetEntry = join(targetDir, entry.name);
      const stats = lstatSync(sourceEntry);

      if (stats.isSymbolicLink()) {
        const linkTarget = resolve(dirname(sourceEntry), readlinkSync(sourceEntry));
        if (!this.isUnderRoot(linkTarget, sourceRoot)) {
          this.logger.warn(`Skipping symlink outside source root: ${sourceEntry} -> ${linkTarget}`);
          continue;
        }
        this.logger.warn(`Skipping symlink during materialization: ${sourceEntry}`);
        continue;
      }

      if (stats.isDirectory()) {
        this.copyDirectory(sourceEntry, targetEntry, sourceRoot);
        continue;
      }

      mkdirSync(dirname(targetEntry), { recursive: true });
      copyFileSync(sourceEntry, targetEntry);
    }
  }

  private shouldSkipEntry(entry: Dirent): boolean {
    return entry.name === '.git';
  }

  private buildManifest(args: {
    scanId: string;
    materializedWorkspaceId: string;
    workspaceId: string | null;
    repoId: string | null;
    sourceType: MaterializedScanWorkspace['sourceType'];
    sourcePath: string;
    materializedPath: string;
    analyzerVisiblePath: string;
  }): RepositoryManifest {
    const rootEntries = existsSync(args.materializedPath)
      ? readdirSync(args.materializedPath).slice(0, 100)
      : [];
    const collected = this.collectManifestData(args.materializedPath, args.materializedPath);

    return {
      scanId: args.scanId,
      materializedWorkspaceId: args.materializedWorkspaceId,
      workspaceId: args.workspaceId,
      repoId: args.repoId,
      sourceType: args.sourceType,
      sourcePath: args.sourcePath,
      materializedPath: args.materializedPath,
      analyzerVisiblePath: args.analyzerVisiblePath,
      createdAt: new Date().toISOString(),
      rootEntries,
      buildFiles: collected.buildFiles,
      ciFiles: collected.ciFiles,
      readmeFiles: collected.readmeFiles,
      sourceFileCount: collected.sourceFileCount,
      languageHints: collected.languageHints,
    };
  }

  private collectManifestData(rootPath: string, currentPath: string): {
    buildFiles: string[];
    ciFiles: string[];
    readmeFiles: string[];
    sourceFileCount: number;
    languageHints: string[];
  } {
    const buildFiles = new Set<string>();
    const ciFiles = new Set<string>();
    const readmeFiles = new Set<string>();
    const languageHints = new Set<string>();
    let sourceFileCount = 0;

    const queue = [currentPath];
    while (queue.length > 0) {
      const dir = queue.shift()!;
      let entries: Dirent[] = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (this.shouldSkipEntry(entry)) continue;
        const fullPath = join(dir, entry.name);
        const relPath = relative(rootPath, fullPath);

        if (entry.isDirectory()) {
          if (relPath.split(sep).length <= 5) queue.push(fullPath);
          if (relPath === '.github' || relPath.startsWith(`.github${sep}`)) {
            ciFiles.add(relPath);
          }
          continue;
        }

        if (/^(Makefile|makefile|GNUmakefile|CMakeLists\.txt|meson\.build|configure\.ac|configure\.in|compile_commands\.json)$/.test(entry.name)) {
          buildFiles.add(relPath);
        }
        if (entry.name === 'README' || entry.name.startsWith('README.')) {
          readmeFiles.add(relPath);
        }
        if (relPath.includes('.github') || relPath === '.gitlab-ci.yml') {
          ciFiles.add(relPath);
        }
        if (/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(entry.name)) {
          sourceFileCount += 1;
          languageHints.add(entry.name.match(/\.(h|hh|hpp|hxx)$/i) ? 'c/c++ headers' : 'c/c++ source');
        }
      }
    }

    return {
      buildFiles: Array.from(buildFiles).sort(),
      ciFiles: Array.from(ciFiles).sort(),
      readmeFiles: Array.from(readmeFiles).sort(),
      sourceFileCount,
      languageHints: Array.from(languageHints).sort(),
    };
  }

  private isUnderRoot(candidatePath: string, rootPath: string): boolean {
    const rel = relative(resolve(rootPath), resolve(candidatePath));
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
  }
}
