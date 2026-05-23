import { Controller, Post, Get, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from '../services/auth.service';
import { Public } from '../decorators/public.decorator';
import { CurrentUser } from '../decorators/current-user.decorator';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('github')
  @HttpCode(HttpStatus.OK)
  async githubAuth(@Body('code') code: string) {
    return this.authService.exchangeGithubCode(code);
  }

  @Get('me')
  async getProfile(@CurrentUser() user: { userId: string }) {
    return this.authService.getProfile(user.userId);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout() {
    // Stateless JWT — client discards token; no server action needed
    return { success: true };
  }
}
