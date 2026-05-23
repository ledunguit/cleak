import {
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { GitHubService } from '../services/github.service';
import { Public } from '../decorators/public.decorator';

@Controller('api/github')
export class GitHubController {
  constructor(private readonly gitHubService: GitHubService) {}

  @Public()
  @Get('auth-url')
  async getAuthUrl(@Query('scope') scope?: string) {
    return this.gitHubService.getAuthUrl(scope);
  }

  @Public()
  @Get('callback')
  async handleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
  ) {
    return this.gitHubService.handleCallback(code, state);
  }

  @Public()
  @Get('status')
  async getStatus() {
    return this.gitHubService.getStatus();
  }

  @Get('repos')
  async listRepos(
    @Query('type') type: string,
    @Query('refresh') refresh: string,
  ) {
    return this.gitHubService.listRepos(type || 'all', refresh === 'true');
  }

  @Get('repos/cached')
  async getCachedRepos() {
    return this.gitHubService.getCachedRepos();
  }

  @Get('auth-url/private-repo')
  async getPrivateRepoAuthUrl(@Query('repo') repoFullName: string) {
    return this.gitHubService.getPrivateRepoAuthUrl(repoFullName);
  }

  @Post('disconnect')
  async disconnect() {
    return this.gitHubService.disconnect();
  }
}
