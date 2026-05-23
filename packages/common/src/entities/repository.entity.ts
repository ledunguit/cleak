import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { WorkspaceEntity } from './workspace.entity';

@Entity('repositories')
export class RepositoryEntity {
  @PrimaryGeneratedColumn('uuid')
  repoId!: string;

  @Column({ nullable: true })
  githubRepoId?: number;

  @Column()
  repoFullName!: string;

  @Column()
  cloneUrl!: string;

  @Column({ default: 'main' })
  defaultBranch!: string;

  @Column({ default: false })
  isPrivate!: boolean;

  @Column({ nullable: true })
  localClonePath?: string;

  @Column({ type: 'bigint', nullable: true })
  lastClonedAt?: number;

  @ManyToOne(() => WorkspaceEntity, (workspace) => workspace.repos, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'workspace_id' })
  workspace!: WorkspaceEntity;

  @Column({ name: 'workspace_id' })
  workspaceId!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
