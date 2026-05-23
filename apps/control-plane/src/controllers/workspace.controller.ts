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
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PersistenceService } from '../services/persistence.service';

@Controller('api/workspaces')
export class WorkspaceController {
  constructor(private readonly persistence: PersistenceService) {}

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
    // If path is provided, add by filesystem path (non-GitHub)
    if (dto.path) {
      return this.persistence.addRepoByPath(id, dto.path, dto.repo_full_name);
    }
    // Otherwise add as GitHub repo
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

  @Delete(':id/repos/:repoId')
  async removeRepo(
    @Param('id') id: string,
    @Param('repoId') repoId: string,
  ) {
    return this.persistence.removeRepo(id, repoId);
  }

  @Post(':id/repos/upload-zip')
  @UseInterceptors(FileInterceptor('file'))
  async uploadRepoZip(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('ZIP file is required');
    return this.persistence.addRepoFromZip(id, file);
  }
}
