import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

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

  @Column()
  accessToken!: string;

  @Column({ nullable: true })
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
