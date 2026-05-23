import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { UserEntity } from './user.entity';

@Entity('scans')
export class ScanEntity {
  @PrimaryGeneratedColumn('uuid')
  scanId!: string;

  @Column({ nullable: true })
  userId?: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;

  @Column()
  workspacePath!: string;

  @Column({ default: 'no_llm' })
  analysisMode!: string;

  @Column({ default: 'off' })
  dynamicMode!: string;

  @Column({ default: 500 })
  fileLimit!: number;

  @Column({ nullable: true })
  buildCommand?: string;

  @Column({ nullable: true })
  workspaceId?: string;

  @Column({ nullable: true })
  repoId?: string;

  @Column({ default: 'pending' })
  status!: string;

  @Column({ type: 'jsonb', nullable: true })
  report?: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  summary?: Record<string, unknown>;

  @Column({ nullable: true })
  dynamicToolPreference?: string;

  @Column({ nullable: true })
  dynamicBinaryPath?: string;

  @Column({ nullable: true })
  dynamicArgs?: string;

  @Column({ type: 'int', nullable: true })
  dynamicTimeoutSec?: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ nullable: true })
  completedAt?: Date;
}
