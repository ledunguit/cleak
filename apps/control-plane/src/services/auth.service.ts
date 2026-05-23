import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '@mcpvul/common';

const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_BASE = 'https://api.github.com';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private clientId: string;
  private clientSecret: string;

  constructor(
    private jwtService: JwtService,
    private config: ConfigService,
    @InjectRepository(UserEntity)
    private userRepo: Repository<UserEntity>,
  ) {
    this.clientId = config.get('GITHUB_CLIENT_ID', '');
    this.clientSecret = config.get('GITHUB_CLIENT_SECRET', '');
  }

  async exchangeGithubCode(code: string): Promise<{ token: string; user: Partial<UserEntity> }> {
    // Exchange code for access token
    const tokenData = await this.exchangeCode(code);
    if (!tokenData.access_token) {
      throw new UnauthorizedException('Failed to obtain GitHub access token');
    }

    // Fetch GitHub user info
    const githubUser = await this.githubApiRequest('/user', tokenData.access_token);

    // Fetch primary email separately (may not be public)
    let email = githubUser.email;
    if (!email) {
      try {
        const emails = await this.githubApiRequest('/user/emails', tokenData.access_token);
        const primary = emails.find((e: any) => e.primary && e.verified);
        email = primary?.email || null;
      } catch { /* non-critical */ }
    }

    // Upsert user
    let user = await this.userRepo.findOneBy({ githubUserId: githubUser.id });
    if (user) {
      user.login = githubUser.login;
      user.name = githubUser.name || null;
      user.email = email || null;
      user.avatarUrl = githubUser.avatar_url || null;
      user.accessToken = tokenData.access_token;
    } else {
      user = this.userRepo.create({
        githubUserId: githubUser.id,
        login: githubUser.login,
        name: githubUser.name || null,
        email: email || null,
        avatarUrl: githubUser.avatar_url || null,
        accessToken: tokenData.access_token,
      });
    }
    user = await this.userRepo.save(user);

    // Sign JWT
    const payload = { sub: user.userId };
    const token = this.jwtService.sign(payload);

    // Remove sensitive fields before returning
    const { accessToken, refreshToken, tokenExpiresAt, ...safeUser } = user;
    return { token, user: safeUser };
  }

  async getProfile(userId: string): Promise<Partial<UserEntity> | null> {
    const user = await this.userRepo.findOneBy({ userId });
    if (!user) return null;
    const { accessToken, refreshToken, tokenExpiresAt, ...safeUser } = user;
    return safeUser;
  }

  async validateUser(userId: string): Promise<UserEntity | null> {
    return this.userRepo.findOneBy({ userId });
  }

  private async exchangeCode(code: string): Promise<any> {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
      }).toString(),
    });
    return response.json();
  }

  private async githubApiRequest(path: string, token: string): Promise<any> {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
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
}
