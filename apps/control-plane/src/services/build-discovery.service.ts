import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { BuildPlan, RepositoryEntity, RepositoryManifest } from '@mcpvul/common';
import { LlmAnalyzerService } from './llm-analyzer.service';

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.yml', '.yaml', '.json', '.toml', '.ini', '.cfg', '.cmake',
  '.mk', '.sh', '.bash', '.zsh', '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp',
]);

const PRIORITY_FILES = [
  'Makefile',
  'makefile',
  'GNUmakefile',
  'CMakeLists.txt',
  'meson.build',
  'configure.ac',
  'configure.in',
  'README.md',
  'README',
  '.github/workflows',
  '.gitlab-ci.yml',
];

interface FileHit {
  path: string;
  fullPath: string;
}

@Injectable()
export class BuildDiscoveryService {
  private readonly logger = new Logger(BuildDiscoveryService.name);

  constructor(
    @InjectRepository(RepositoryEntity)
    private readonly repoRepo: Repository<RepositoryEntity>,
    private readonly llmAnalyzer: LlmAnalyzerService,
  ) {}

  async discover(params: {
    workspaceId?: string;
    repoId?: string;
    workspacePath?: string;
    repositoryManifest?: RepositoryManifest;
    preferLlm?: boolean;
  }): Promise<BuildPlan> {
    const repo = params.repoId
      ? await this.repoRepo.findOneBy({ repoId: params.repoId, workspaceId: params.workspaceId })
      : null;

    const repoPath = params.workspacePath || repo?.localClonePath;
    if (!repoPath || !existsSync(repoPath)) {
      return this.fallbackPlan('missing_workspace', params.workspacePath || '.');
    }

    const hits = this.findInterestingFiles(repoPath, params.repositoryManifest);
    const heuristic = this.detectHeuristically(repoPath, hits, params.repositoryManifest);

    if (params.preferLlm !== false && repo?.repoId && repo.workspaceId) {
      try {
        const llm = await this.llmAnalyzer.analyze(repo.workspaceId, repo.repoId);
        if (llm.buildCommand?.trim()) {
          return {
            ...heuristic,
            buildCommand: llm.buildCommand,
            sanitizerVariants: {
              ...heuristic.sanitizerVariants,
              default: llm.buildCommand,
              lsan: llm.lsanSupported ? llm.buildCommand : heuristic.sanitizerVariants.lsan,
            },
            evidence: [
              ...heuristic.evidence,
              {
                kind: 'llm',
                detail: `LLM inspected ${llm.filesExamined?.length || 0} file(s): ${llm.lsanNote || 'build command selected'}`,
              },
            ],
            strategy: 'llm',
          };
        }
      } catch (err: any) {
        this.logger.warn(`LLM build discovery failed, falling back to heuristic: ${err.message}`);
      }
    }

    return heuristic;
  }

  private detectHeuristically(repoPath: string, hits: FileHit[], manifest?: RepositoryManifest): BuildPlan {
    const hitPaths = new Set(hits.map((hit) => hit.path));
    const evidence: BuildPlan['evidence'] = this.buildEvidenceFromManifest(manifest);

    for (const hit of hits.slice(0, 12)) {
      evidence.push({
        kind: this.isLikelyCiFile(hit.path) ? 'ci_file' : 'build_file',
        path: hit.path,
        detail: `Detected ${hit.path}`,
      });
    }

    const compileCommands = hits.find((hit) => hit.path.endsWith('compile_commands.json'));
    if (compileCommands) {
      const buildDir = dirname(compileCommands.path);
      return {
        buildSystem: 'compile_commands',
        workingDirectory: buildDir === '.' ? repoPath : join(repoPath, buildDir),
        buildCommand: buildDir === '.'
          ? 'cmake -S . -B build -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_EXPORT_COMPILE_COMMANDS=ON && cmake --build build'
          : `cmake --build ${buildDir}`,
        cleanCommand: buildDir === '.' ? 'rm -rf build' : `cmake --build ${buildDir} --target clean`,
        binaryCandidates: this.findBinaryHints(repoPath),
        compilerOverrides: { CC: 'clang', CXX: 'clang++' },
        sanitizerVariants: {
          default: buildDir === '.'
            ? 'cmake -S . -B build -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_EXPORT_COMPILE_COMMANDS=ON && cmake --build build'
            : `cmake --build ${buildDir}`,
          asan: buildDir === '.'
            ? 'cmake -S . -B build-asan -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_FLAGS="-fsanitize=address -fno-omit-frame-pointer" -DCMAKE_CXX_FLAGS="-fsanitize=address -fno-omit-frame-pointer" && cmake --build build-asan'
            : `cmake --build ${buildDir}`,
          lsan: buildDir === '.'
            ? 'cmake -S . -B build-lsan -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_FLAGS="-fsanitize=leak -g" -DCMAKE_CXX_FLAGS="-fsanitize=leak -g" && cmake --build build-lsan'
            : `cmake --build ${buildDir}`,
          valgrind: buildDir === '.'
            ? 'cmake -S . -B build -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ && cmake --build build'
            : `cmake --build ${buildDir}`,
        },
        requiredEnv: {},
        evidence,
        strategy: 'heuristic',
      };
    }

    if (hitPaths.has('CMakeLists.txt')) {
      return {
        buildSystem: 'cmake',
        workingDirectory: repoPath,
        configureCommand: 'cmake -S . -B build -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
        buildCommand: 'cmake -S . -B build -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_EXPORT_COMPILE_COMMANDS=ON && cmake --build build',
        cleanCommand: 'rm -rf build',
        binaryCandidates: this.findBinaryHints(repoPath),
        compilerOverrides: { CC: 'clang', CXX: 'clang++' },
        sanitizerVariants: {
          default: 'cmake -S . -B build -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_EXPORT_COMPILE_COMMANDS=ON && cmake --build build',
          asan: 'cmake -S . -B build-asan -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_FLAGS="-fsanitize=address -fno-omit-frame-pointer" -DCMAKE_CXX_FLAGS="-fsanitize=address -fno-omit-frame-pointer" && cmake --build build-asan',
          lsan: 'cmake -S . -B build-lsan -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_FLAGS="-fsanitize=leak -g" -DCMAKE_CXX_FLAGS="-fsanitize=leak -g" && cmake --build build-lsan',
          valgrind: 'cmake -S . -B build-vg -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ && cmake --build build-vg',
        },
        requiredEnv: {},
        evidence,
        strategy: 'heuristic',
      };
    }

    if (hitPaths.has('meson.build')) {
      return {
        buildSystem: 'meson',
        workingDirectory: repoPath,
        configureCommand: 'CC=clang CXX=clang++ meson setup build',
        buildCommand: 'CC=clang CXX=clang++ meson setup build --reconfigure || CC=clang CXX=clang++ meson setup build && meson compile -C build',
        cleanCommand: 'rm -rf build',
        binaryCandidates: this.findBinaryHints(repoPath),
        compilerOverrides: { CC: 'clang', CXX: 'clang++' },
        sanitizerVariants: {
          default: 'CC=clang CXX=clang++ meson setup build --reconfigure || CC=clang CXX=clang++ meson setup build && meson compile -C build',
          asan: 'CC=clang CXX=clang++ CFLAGS="-fsanitize=address -fno-omit-frame-pointer" CXXFLAGS="-fsanitize=address -fno-omit-frame-pointer" meson setup build-asan --reconfigure || CC=clang CXX=clang++ CFLAGS="-fsanitize=address -fno-omit-frame-pointer" CXXFLAGS="-fsanitize=address -fno-omit-frame-pointer" meson setup build-asan && meson compile -C build-asan',
          lsan: 'CC=clang CXX=clang++ CFLAGS="-fsanitize=leak -g" CXXFLAGS="-fsanitize=leak -g" meson setup build-lsan --reconfigure || CC=clang CXX=clang++ CFLAGS="-fsanitize=leak -g" CXXFLAGS="-fsanitize=leak -g" meson setup build-lsan && meson compile -C build-lsan',
          valgrind: 'CC=clang CXX=clang++ meson setup build-vg --reconfigure || CC=clang CXX=clang++ meson setup build-vg && meson compile -C build-vg',
        },
        requiredEnv: {},
        evidence,
        strategy: 'heuristic',
      };
    }

    if (hitPaths.has('configure.ac') || hitPaths.has('configure.in')) {
      return {
        buildSystem: 'autotools',
        workingDirectory: repoPath,
        configureCommand: 'CC=clang CXX=clang++ ./configure',
        buildCommand: 'CC=clang CXX=clang++ ./configure && make -j$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)',
        cleanCommand: 'make clean',
        binaryCandidates: this.findBinaryHints(repoPath),
        compilerOverrides: { CC: 'clang', CXX: 'clang++' },
        sanitizerVariants: {
          default: 'CC=clang CXX=clang++ ./configure && make -j$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)',
          asan: 'CC=clang CXX=clang++ CFLAGS="-fsanitize=address -fno-omit-frame-pointer" CXXFLAGS="-fsanitize=address -fno-omit-frame-pointer" ./configure && make -j$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)',
          lsan: 'CC=clang CXX=clang++ CFLAGS="-fsanitize=leak -g" CXXFLAGS="-fsanitize=leak -g" ./configure && make -j$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)',
          valgrind: 'CC=clang CXX=clang++ ./configure && make -j$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)',
        },
        requiredEnv: {},
        evidence,
        strategy: 'heuristic',
      };
    }

    if (hitPaths.has('Makefile') || hitPaths.has('makefile') || hitPaths.has('GNUmakefile')) {
      return {
        buildSystem: 'make',
        workingDirectory: repoPath,
        buildCommand: 'make CC=clang CXX=clang++',
        cleanCommand: 'make clean',
        binaryCandidates: this.findBinaryHints(repoPath),
        compilerOverrides: { CC: 'clang', CXX: 'clang++' },
        sanitizerVariants: {
          default: 'make CC=clang CXX=clang++',
          asan: 'make CC=clang CXX=clang++ CFLAGS="-fsanitize=address -fno-omit-frame-pointer" CXXFLAGS="-fsanitize=address -fno-omit-frame-pointer"',
          lsan: 'make CC=clang CXX=clang++ CFLAGS="-fsanitize=leak -g" CXXFLAGS="-fsanitize=leak -g"',
          valgrind: 'make CC=clang CXX=clang++',
        },
        requiredEnv: {},
        evidence,
        strategy: 'heuristic',
      };
    }

    evidence.push({
      kind: 'heuristic',
      detail: 'No standard build metadata found; using clang make fallback.',
    });
    return this.fallbackPlan('heuristic_fallback', repoPath, evidence);
  }

  private fallbackPlan(reason: string, repoPath: string, evidence: BuildPlan['evidence'] = []): BuildPlan {
    return {
      buildSystem: 'unknown',
      workingDirectory: repoPath,
      buildCommand: 'make CC=clang CXX=clang++',
      cleanCommand: 'make clean',
      binaryCandidates: this.findBinaryHints(repoPath),
      compilerOverrides: { CC: 'clang', CXX: 'clang++' },
      sanitizerVariants: {
        default: 'make CC=clang CXX=clang++',
        asan: 'make CC=clang CXX=clang++ CFLAGS="-fsanitize=address -fno-omit-frame-pointer" CXXFLAGS="-fsanitize=address -fno-omit-frame-pointer"',
        lsan: 'make CC=clang CXX=clang++ CFLAGS="-fsanitize=leak -g" CXXFLAGS="-fsanitize=leak -g"',
        valgrind: 'make CC=clang CXX=clang++',
      },
      requiredEnv: {},
      evidence: [
        ...evidence,
        { kind: 'heuristic', detail: `Fallback selected: ${reason}` },
      ],
      strategy: 'heuristic',
    };
  }

  private findInterestingFiles(rootPath: string, manifest?: RepositoryManifest): FileHit[] {
    if (manifest) {
      const manifestHits = [
        ...manifest.buildFiles,
        ...manifest.ciFiles,
        ...manifest.readmeFiles,
      ]
        .filter((path, index, all) => all.indexOf(path) === index)
        .map((path) => ({ path, fullPath: join(rootPath, path) }))
        .filter((hit) => existsSync(hit.fullPath));
      if (manifestHits.length > 0) {
        return manifestHits;
      }
    }

    const hits: FileHit[] = [];
    const queue = [rootPath];

    while (queue.length > 0 && hits.length < 200) {
      const current = queue.shift()!;
      let entries: string[] = [];
      try {
        entries = readdirSync(current);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(current, entry);
        let stats;
        try {
          stats = statSync(fullPath);
        } catch {
          continue;
        }

        const relPath = relative(rootPath, fullPath) || '.';
        if (stats.isDirectory()) {
          if (entry === '.git' || entry === 'node_modules' || entry === 'dist') continue;
          if (PRIORITY_FILES.some((path) => relPath === path || relPath.startsWith(`${path}/`))) {
            hits.push({ path: relPath, fullPath });
          }
          if (relPath.split('/').length <= 4) {
            queue.push(fullPath);
          }
          continue;
        }

        if (
          PRIORITY_FILES.includes(entry) ||
          relPath.endsWith('compile_commands.json') ||
          relPath.endsWith('CMakeLists.txt') ||
          relPath.endsWith('meson.build') ||
          relPath.endsWith('configure.ac') ||
          relPath.endsWith('configure.in') ||
          this.isTextLike(relPath)
        ) {
          hits.push({ path: relPath, fullPath });
        }
      }
    }

    hits.sort((a, b) => Number(this.isPriority(a.path)) - Number(this.isPriority(b.path)));
    return hits;
  }

  private isPriority(relPath: string): boolean {
    return !PRIORITY_FILES.some((path) => relPath === path || relPath.startsWith(`${path}/`));
  }

  private isLikelyCiFile(relPath: string): boolean {
    return relPath.includes('.github/') || relPath.includes('.gitlab-ci');
  }

  private isTextLike(relPath: string): boolean {
    const ext = relPath.includes('.') ? `.${relPath.split('.').pop()!.toLowerCase()}` : '';
    return TEXT_EXTENSIONS.has(ext);
  }

  private findBinaryHints(rootPath: string): string[] {
    const hints = new Set<string>();
    for (const candidate of ['build', 'bin', 'out', 'dist']) {
      const fullPath = join(rootPath, candidate);
      if (existsSync(fullPath)) hints.add(candidate);
    }

    const readmePath = ['README.md', 'README'].find((candidate) => existsSync(join(rootPath, candidate)));
    if (readmePath) {
      try {
        const content = readFileSync(join(rootPath, readmePath), 'utf-8');
        const matches = content.match(/(?:\.\/|build\/|bin\/)[A-Za-z0-9_./-]+/g) || [];
        for (const match of matches.slice(0, 10)) {
          hints.add(match.replace(/^\.\//, ''));
        }
      } catch {
        // ignore README parsing errors
      }
    }

    return Array.from(hints);
  }

  private buildEvidenceFromManifest(manifest?: RepositoryManifest): BuildPlan['evidence'] {
    if (!manifest) return [];

    const evidence: BuildPlan['evidence'] = [
      {
        kind: 'heuristic',
        detail: `Repository manifest: ${manifest.sourceFileCount} C/C++ file(s), source=${manifest.sourceType}`,
      },
    ];

    for (const file of manifest.buildFiles.slice(0, 8)) {
      evidence.push({
        kind: 'build_file',
        path: file,
        detail: `Manifest build file ${file}`,
      });
    }

    for (const file of manifest.ciFiles.slice(0, 4)) {
      evidence.push({
        kind: 'ci_file',
        path: file,
        detail: `Manifest CI file ${file}`,
      });
    }

    for (const file of manifest.readmeFiles.slice(0, 2)) {
      evidence.push({
        kind: 'readme',
        path: file,
        detail: `Manifest README file ${file}`,
      });
    }

    return evidence;
  }
}
