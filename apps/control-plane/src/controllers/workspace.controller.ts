import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Sse,
  MaxFileSizeValidator,
  ParseFilePipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { extname, join } from 'path';
import { Observable } from 'rxjs';
import { PersistenceService } from '../services/persistence.service';
import { LlmAnalyzerService } from '../services/llm-analyzer.service';
import { ScanService } from '../services/scan.service';
import { LlmAnalyzeResponseDto } from '@mcpvul/common';
import { Public } from '../decorators/public.decorator';
import { mkdirSync, existsSync } from 'fs';

@Controller('api/workspaces')
export class WorkspaceController {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly llmAnalyzer: LlmAnalyzerService,
    private readonly scanService: ScanService,
  ) {}

  @Get()
  async listWorkspaces() {
    return this.persistence.listWorkspaces();
  }

  @Post()
  async createWorkspace(@Body() dto: { name: string; path?: string }) {
    return this.persistence.createWorkspace(dto.name, dto.path || dto.name);
  }

  @Get(':id')
  async getWorkspace(@Param('id') id: string) {
    return this.persistence.getWorkspace(id);
  }

  @Delete(':id')
  async deleteWorkspace(@Param('id') id: string) {
    return this.persistence.deleteWorkspace(id);
  }

  @Post(':id/settings')
  async updateSettings(
    @Param('id') id: string,
    @Body() dto: { settings: Record<string, unknown> },
  ) {
    return this.persistence.updateWorkspaceSettings(id, dto.settings);
  }

  @Post(':id/repos')
  async addRepo(
    @Param('id') id: string,
    @Body() dto: {
      github_repo_id?: number;
      repo_full_name?: string;
      clone_url?: string;
      default_branch?: string;
      is_private?: boolean;
      path?: string;
    },
  ) {
    if (dto.path) {
      return this.persistence.addRepoByPath(id, dto.path, dto.repo_full_name);
    }
    return this.persistence.addRepo(id, dto as any);
  }

  @Post(':id/repos/:repoId/clone')
  async cloneRepo(
    @Param('id') id: string,
    @Param('repoId') repoId: string,
  ) {
    return this.persistence.cloneRepo(id, repoId);
  }

  @Post(':id/repos/:repoId/detect-build')
  async detectBuild(
    @Param('id') id: string,
    @Param('repoId') repoId: string,
  ) {
    return this.persistence.detectBuild(id, repoId);
  }

  @Get(':id/repos/:repoId/llm-analyze')
  @Sse()
  @Public()
  async llmAnalyzeStream(
    @Param('id') id: string,
    @Param('repoId') repoId: string,
  ): Promise<Observable<MessageEvent>> {
    return this.llmAnalyzer.analyzeWithSSE(id, repoId);
  }

  @Post(':id/repos/:repoId/llm-analyze')
  async llmAnalyzeSync(
    @Param('id') id: string,
    @Param('repoId') repoId: string,
  ): Promise<LlmAnalyzeResponseDto> {
    return this.llmAnalyzer.analyze(id, repoId);
  }

  @Delete(':id/repos/:repoId')
  async removeRepo(
    @Param('id') id: string,
    @Param('repoId') repoId: string,
  ) {
    return this.persistence.removeRepo(id, repoId);
  }

  /**
   * Upload a ZIP file and extract it as a repository in the workspace.
   * Supports files up to 500MB.
   */
  @Post(':id/repos/upload-zip')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 500 * 1024 * 1024 },
      fileFilter: (_req: any, file: any, cb: any) => {
        const ext = file.originalname.toLowerCase().split('.').pop();
        if (ext !== 'zip') { cb(new Error('Only ZIP files are accepted'), false); return; }
        cb(null, true);
      },
    }),
  )
  async uploadRepoZip(
    @Param('id') id: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 500 * 1024 * 1024 })],
      }),
    )
    file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('ZIP file is required');

    return this.persistence.addRepoFromZip(id, {
      ...file,
      buffer: file.buffer || require('fs').readFileSync(file.path),
    });
  }

  /**
   * Upload a ZIP and immediately start a scan on it.
   * One-step flow: upload → extract → scan.
   */
  @Post(':id/repos/upload-and-scan')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 500 * 1024 * 1024 },
      fileFilter: (_req: any, file: any, cb: any) => {
        const ext = file.originalname.toLowerCase().split('.').pop();
        if (ext !== 'zip') { cb(new Error('Only ZIP files are accepted'), false); return; }
        cb(null, true);
      },
    }),
  )
  async uploadAndScan(
    @Param('id') id: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 500 * 1024 * 1024 })],
      }),
    )
    file: Express.Multer.File,
    @Body('analysisMode') analysisMode?: string,
    @Body('dynamicMode') dynamicMode?: string,
    @Body('fileLimit') fileLimit?: string,
    @Body('buildCommand') buildCommand?: string,
  ) {
    if (!file) throw new BadRequestException('ZIP file is required');

    // Extract zip
    const repoResult = await this.persistence.addRepoFromZip(id, {
      ...file,
      buffer: file.buffer || require('fs').readFileSync(file.path),
    });

    // Start scan on the extracted repo
    const scanResult = await this.scanService.createScan({
      workspacePath: repoResult.local_clone_path,
      sourceType: 'upload_zip',
      analysisMode: (analysisMode as any) || process.env.DEFAULT_ANALYSIS_MODE || 'llm_assisted',
      dynamicMode: (dynamicMode as any) || 'off',
      fileLimit: fileLimit ? parseInt(fileLimit, 10) : 500,
      buildCommand: buildCommand?.trim() || undefined,
      workspaceId: id,
    });

    return {
      repo: repoResult,
      scan: scanResult,
    };
  }

  /**
   * Clone a public GitHub repo by URL (no OAuth needed) and optionally scan.
   */
  @Post(':id/repos/clone-url')
  async cloneByUrl(
    @Param('id') id: string,
    @Body() dto: {
      url: string;
      name?: string;
      scan_now?: boolean;
      analysisMode?: string;
      dynamicMode?: string;
    },
  ) {
    if (!dto.url) throw new BadRequestException('Git clone URL is required');

    // Validate URL
    if (!dto.url.startsWith('https://') && !dto.url.startsWith('git@')) {
      throw new BadRequestException('URL must be a valid git clone URL (https:// or git@)');
    }

    const repoResult = await this.persistence.cloneByPublicUrl(id, dto.url, dto.name);

    if (dto.scan_now) {
      const scanResult = await this.scanService.createScan({
        workspacePath: repoResult.local_clone_path,
        sourceType: 'github',
        analysisMode: (dto.analysisMode as any) || process.env.DEFAULT_ANALYSIS_MODE || 'llm_assisted',
        dynamicMode: (dto.dynamicMode as any) || 'off',
        fileLimit: 500,
        workspaceId: id,
      });

      return { repo: repoResult, scan: scanResult };
    }

    return { repo: repoResult };
  }
}
