import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { encryptedColumn } from './encrypted-column';

@Entity('github_connections')
export class GitHubConnectionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  githubUserId!: number;

  @Column()
  login!: string;

  @Column({ nullable: true })
  avatarUrl?: string;

  @Column({ transformer: encryptedColumn })
  accessToken!: string;

  @Column({ nullable: true, transformer: encryptedColumn })
  refreshToken?: string;

  @Column({ nullable: true })
  tokenExpiresAt?: Date;

  @Column({ type: 'json', nullable: true })
  cachedRepos?: Record<string, any>[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
